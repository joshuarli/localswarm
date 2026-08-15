//! Concurrent local Pi agents backed by one oMLX Laguna XS 2.1 server.
//!
//! The application owns the world boundary: workspace paths, process execution,
//! cancellation deadlines, verification, and the explicit local provider
//! configuration. pi-agent-core owns the agent loop and standard coding-tool
//! contracts; it does not discover host configuration or create an executor.

use pi_agent_core::default_tools::CommandEnvironment;
use pi_agent_core::profile::PiDefaultCodingProfile;
use pi_agent_core::provider::local::{LocalConfig, DEFAULT_BASE_URL, LAGUNA_XS_2_1_MODEL};
use pi_agent_core::provider::openai::OpenAiContextHook;
use pi_agent_core::provider::{ProviderConfiguration, ProviderRegistry};
use pi_agent_core::scheduler::ModelProvider;
use pi_agent_core::state::{ModelDescriptor, RunPhase, StopReason, Usage};
use pi_agent_core::{Agent, DefaultCodingTools};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_SECONDS: u64 = 300;
const DEFAULT_LEVELS: &[usize] = &[1, 2, 4, 6, 8];
const COMMAND_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

const FIBONACCI_TASK: &str = r#"Create fib.py containing a clean iterative Fibonacci implementation.

Create test_fib.py using only Python's standard library. Test the zero, one, and several-number cases.

Run python3 test_fib.py with the bash tool. Stop when it passes."#;

const PRIME_TASK: &str = r#"Create prime.py containing a clean primality-test implementation.

Create test_prime.py using only Python's standard library. Test small primes, composites, zero, and one.

Run python3 test_prime.py with the bash tool. Stop when it passes."#;

const INTERVAL_TASK: &str = r#"Work only inside this actor workspace. Implement and test an inclusive integer interval merger in Python using only the standard library.

Write intervals.py with merge_intervals(intervals: list[tuple[int, int]]) -> list[tuple[int, int]]. It must return a new list sorted by start, merge overlapping and adjacent integer intervals, preserve the input, and raise ValueError when start > end.

Write test_intervals.py importing with from intervals import merge_intervals. Test unsorted chained, overlapping, adjacent, one-integer gap, negative, empty input, input immutability, and invalid intervals. Use no third-party packages.

Run python3 test_intervals.py with the bash tool. Stop immediately after exit code 0."#;

const READY_TASK: &str = "Reply with exactly READY and no additional text. Do not call any tools.";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Mode {
    Poc,
    Benchmark,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Workload {
    Programming,
    Ready,
}

#[derive(Clone, Debug)]
struct Options {
    mode: Mode,
    workload: Workload,
    base_url: String,
    workspace_root: PathBuf,
    levels: Vec<usize>,
    repeats: usize,
    timeout: Duration,
    stagger: Duration,
    keep: bool,
}

impl Options {
    fn parse() -> Result<Self, String> {
        let current_dir = env::current_dir()
            .map_err(|error| format!("cannot resolve the explicit workspace root: {error}"))?;
        let mut options = Self {
            mode: Mode::Poc,
            workload: Workload::Programming,
            base_url: DEFAULT_BASE_URL.to_owned(),
            workspace_root: current_dir.join("workspaces"),
            levels: DEFAULT_LEVELS.to_vec(),
            repeats: 1,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECONDS),
            stagger: Duration::ZERO,
            keep: false,
        };
        let mut arguments = env::args().skip(1);
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--help" | "-h" => {
                    println!("{}", usage());
                    std::process::exit(0);
                }
                "--keep" => options.keep = true,
                "--mode" => {
                    options.mode = parse_mode(next_value(&mut arguments, "--mode")?)?;
                }
                "--workload" => {
                    options.workload = parse_workload(next_value(&mut arguments, "--workload")?)?;
                }
                "--base-url" => {
                    options.base_url = next_value(&mut arguments, "--base-url")?;
                }
                "--workspace-root" => {
                    options.workspace_root =
                        PathBuf::from(next_value(&mut arguments, "--workspace-root")?);
                }
                "--levels" => {
                    options.levels = parse_levels(&next_value(&mut arguments, "--levels")?)?;
                }
                "--repeats" => {
                    options.repeats =
                        parse_positive(&next_value(&mut arguments, "--repeats")?, "repeats")?;
                }
                "--timeout-seconds" => {
                    let seconds = parse_positive(
                        &next_value(&mut arguments, "--timeout-seconds")?,
                        "timeout-seconds",
                    )?;
                    options.timeout = Duration::from_secs(seconds as u64);
                }
                "--stagger-ms" => {
                    let milliseconds = parse_non_negative(
                        &next_value(&mut arguments, "--stagger-ms")?,
                        "stagger-ms",
                    )?;
                    options.stagger = Duration::from_millis(milliseconds as u64);
                }
                value => return Err(format!("unknown argument {value:?}\n\n{}", usage())),
            }
        }
        if options.base_url.trim().is_empty() {
            return Err("--base-url must not be empty".to_owned());
        }
        Ok(options)
    }
}

fn usage() -> &'static str {
    "usage: localswarm [--mode poc|benchmark] [--workload programming|ready] [--base-url URL] [--workspace-root DIR] [--levels 1,2,4] [--repeats N] [--timeout-seconds N] [--stagger-ms N] [--keep]"
}

fn next_value(arguments: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    arguments
        .next()
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn parse_mode(value: String) -> Result<Mode, String> {
    match value.as_str() {
        "poc" => Ok(Mode::Poc),
        "benchmark" => Ok(Mode::Benchmark),
        _ => Err("--mode must be poc or benchmark".to_owned()),
    }
}

fn parse_workload(value: String) -> Result<Workload, String> {
    match value.as_str() {
        "programming" => Ok(Workload::Programming),
        "ready" => Ok(Workload::Ready),
        _ => Err("--workload must be programming or ready".to_owned()),
    }
}

fn parse_positive(value: &str, name: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("--{name} must be a positive integer"))
}

fn parse_non_negative(value: &str, name: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|_| format!("--{name} must be a non-negative integer"))
}

fn parse_levels(value: &str) -> Result<Vec<usize>, String> {
    let mut levels = value
        .split(',')
        .map(|level| parse_positive(level, "levels"))
        .collect::<Result<Vec<_>, _>>()?;
    levels.sort_unstable();
    levels.dedup();
    if levels.is_empty() {
        return Err("--levels must contain at least one positive integer".to_owned());
    }
    Ok(levels)
}

fn configured_provider(
    base_url: &str,
) -> Result<(ModelDescriptor, Arc<dyn ModelProvider>), String> {
    let registry = ProviderRegistry::new();
    let selection = registry
        .resolve_model("local", LAGUNA_XS_2_1_MODEL)
        .map_err(|error| format!("local provider registry rejected Laguna: {error}"))?;
    let configuration = LocalConfig::laguna_xs_2_1(base_url);
    configuration
        .validate()
        .map_err(|error| format!("invalid oMLX configuration: {error}"))?;
    let configured = registry
        .build(
            selection.into_descriptor(),
            ProviderConfiguration::Local(configuration),
        )
        .map_err(|error| format!("could not construct local provider: {error}"))?;
    Ok((configured.descriptor, configured.provider))
}

fn create_agent(
    workspace: &Path,
    model: ModelDescriptor,
    provider: Arc<dyn ModelProvider>,
) -> Result<Agent, String> {
    fs::create_dir_all(workspace)
        .map_err(|error| format!("cannot create workspace {}: {error}", workspace.display()))?;
    let tools = DefaultCodingTools::new(workspace)
        .map_err(|error| format!("cannot create coding tools: {error}"))?
        .with_environment(CommandEnvironment::empty().with("PATH", COMMAND_PATH));
    let profile = PiDefaultCodingProfile::pinned_default()
        .map_err(|error| format!("cannot load pinned Pi coding profile: {error}"))?;
    let registry = tools.registry();
    profile
        .validate_registry(&registry)
        .map_err(|error| format!("pinned profile/tool registry mismatch: {error}"))?;
    let system_prompt = profile.system_prompt_for_workspace(tools.workspace().as_path());
    Ok(Agent::builder()
        .model(model)
        .system_prompt(system_prompt)
        .tools(registry)
        .hooks(Arc::new(OpenAiContextHook))
        .model_provider(provider)
        .build())
}

struct DeadlineGuard {
    disarmed: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    worker: Option<JoinHandle<()>>,
}

impl DeadlineGuard {
    fn arm(deadline: Duration, agent: Agent) -> Self {
        let disarmed = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let worker_disarmed = Arc::clone(&disarmed);
        let worker = thread::spawn(move || {
            let (lock, wake) = &*worker_disarmed;
            let armed = lock.lock().expect("deadline mutex poisoned");
            let (armed, waited) = wake
                .wait_timeout_while(armed, deadline, |disarmed| !*disarmed)
                .expect("deadline condition variable poisoned");
            if !*armed && waited.timed_out() {
                agent.abort();
            }
        });
        Self {
            disarmed,
            worker: Some(worker),
        }
    }

    fn disarm(&mut self) {
        let (lock, wake) = &*self.disarmed;
        *lock.lock().expect("deadline mutex poisoned") = true;
        wake.notify_all();
        if let Some(worker) = self.worker.take() {
            worker.join().expect("deadline worker panicked");
        }
    }
}

impl Drop for DeadlineGuard {
    fn drop(&mut self) {
        self.disarm();
    }
}

#[derive(Clone)]
struct ActorSpec {
    id: String,
    workspace: PathBuf,
    instruction: String,
    model: ModelDescriptor,
    provider: Arc<dyn ModelProvider>,
    timeout: Duration,
}

#[derive(Debug)]
struct ActorOutcome {
    id: String,
    workspace: PathBuf,
    status: &'static str,
    elapsed: Duration,
    event_count: u64,
    stop_reason: Option<StopReason>,
    usage: Usage,
    error: Option<String>,
}

fn run_actor(spec: ActorSpec) -> ActorOutcome {
    let started = Instant::now();
    let agent = match create_agent(&spec.workspace, spec.model, spec.provider) {
        Ok(agent) => agent,
        Err(error) => {
            return ActorOutcome {
                id: spec.id,
                workspace: spec.workspace,
                status: "failure",
                elapsed: started.elapsed(),
                event_count: 0,
                stop_reason: None,
                usage: Usage::default(),
                error: Some(error),
            }
        }
    };
    let run = match agent.start_prompt(spec.instruction) {
        Ok(run) => run,
        Err(error) => {
            return ActorOutcome {
                id: spec.id,
                workspace: spec.workspace,
                status: "failure",
                elapsed: started.elapsed(),
                event_count: 0,
                stop_reason: None,
                usage: Usage::default(),
                error: Some(error.to_string()),
            }
        }
    };
    let mut deadline = DeadlineGuard::arm(spec.timeout, agent.clone());
    let drive_result = smol::block_on(run.drive());
    deadline.disarm();
    let run_snapshot = run.snapshot();
    let snapshot = agent.snapshot();
    let drive_error = drive_result.err().map(|error| error.to_string());
    let status = if run_snapshot.phase == RunPhase::Succeeded {
        "success"
    } else {
        "failure"
    };
    let error = drive_error.or_else(|| snapshot.last_error.clone());
    ActorOutcome {
        id: spec.id,
        workspace: spec.workspace,
        status,
        elapsed: started.elapsed(),
        event_count: run.events().len() as u64,
        stop_reason: run_snapshot.stop_reason,
        usage: snapshot.accounting.aggregate,
        error,
    }
}

fn run_concurrent(specs: Vec<ActorSpec>, stagger: Duration) -> Vec<ActorOutcome> {
    let mut workers = Vec::with_capacity(specs.len());
    for (index, spec) in specs.into_iter().enumerate() {
        if index > 0 && !stagger.is_zero() {
            thread::sleep(stagger);
        }
        workers.push(thread::spawn(move || run_actor(spec)));
    }
    workers
        .into_iter()
        .map(|worker| worker.join().expect("actor worker panicked"))
        .collect()
}

fn task_for(workload: Workload, actor_id: &str) -> String {
    match workload {
        Workload::Ready => READY_TASK.to_owned(),
        Workload::Programming => match actor_id {
            "actor-a" => FIBONACCI_TASK.to_owned(),
            "actor-b" => PRIME_TASK.to_owned(),
            _ => INTERVAL_TASK.to_owned(),
        },
    }
}

fn verify_workspace(workspace: &Path, expected_file: Option<&str>) -> Result<(), String> {
    if let Some(expected_file) = expected_file {
        let artifact = workspace.join(expected_file);
        if !artifact.is_file() {
            return Err(format!("{} is not a file", artifact.display()));
        }
        let mut tests = Vec::new();
        collect_test_files(workspace, &mut tests)?;
        tests.sort();
        if tests.is_empty() {
            return Err("no test_*.py file was created".to_owned());
        }
        for test in tests {
            run_python_test(workspace, &test)?;
        }
    }
    Ok(())
}

fn collect_test_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| format!("cannot inspect workspace: {error}"))? {
        let entry = entry.map_err(|error| format!("cannot inspect workspace entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("cannot inspect workspace entry: {error}"))?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_test_files(&path, files)?;
        } else if file_type.is_file()
            && path.file_name().is_some_and(|name| {
                let name = name.to_string_lossy();
                name.starts_with("test_") && name.ends_with(".py")
            })
        {
            files.push(path);
        }
    }
    Ok(())
}

fn run_python_test(workspace: &Path, test_file: &Path) -> Result<(), String> {
    let relative = test_file
        .strip_prefix(workspace)
        .map_err(|_| format!("test escaped workspace: {}", test_file.display()))?;
    let output = std::process::Command::new("python3")
        .env_clear()
        .env("PATH", COMMAND_PATH)
        .current_dir(workspace)
        .arg(relative)
        .output()
        .map_err(|error| format!("could not run {}: {error}", relative.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "{} failed: {}{}",
        relative.display(),
        stdout,
        if stderr.is_empty() {
            String::new()
        } else {
            format!("\n{stderr}")
        }
    ))
}

fn print_outcome(outcome: &ActorOutcome, verification: Result<(), String>) {
    let usage = &outcome.usage;
    println!("{}:", outcome.id);
    println!("  status: {}", outcome.status);
    println!("  workspace: {}", outcome.workspace.display());
    println!("  elapsed: {:.1}s", outcome.elapsed.as_secs_f64());
    println!("  lifecycle events: {}", outcome.event_count);
    println!("  stop reason: {:?}", outcome.stop_reason);
    println!("  input tokens: {:?}", usage.input_tokens);
    println!("  output tokens: {:?}", usage.output_tokens);
    println!("  cached tokens: {:?}", usage.cache_read_tokens);
    if let Some(error) = &outcome.error {
        println!("  error: {error}");
    }
    match verification {
        Ok(()) => println!("  verification: passed"),
        Err(error) => println!("  verification: failed ({error})"),
    }
}

fn run_poc(options: &Options) -> Result<(), String> {
    fs::create_dir_all(&options.workspace_root)
        .map_err(|error| format!("cannot create workspace root: {error}"))?;
    let (model, provider) = configured_provider(&options.base_url)?;
    println!("=== LOCAL oMLX / LAGUNA AUDIT ===");
    println!("provider: local");
    println!("model: {}", model.model);
    println!("endpoint: {}", options.base_url);
    println!("context window: 32768");
    println!("tools: read, bash, edit, write");
    println!("configuration discovery: none");

    let specs = [("actor-a", "fib.py"), ("actor-b", "prime.py")]
        .into_iter()
        .map(|(id, _)| ActorSpec {
            id: id.to_owned(),
            workspace: options.workspace_root.join(id),
            instruction: task_for(options.workload, id),
            model: model.clone(),
            provider: Arc::clone(&provider),
            timeout: options.timeout,
        })
        .collect();
    let started = Instant::now();
    let outcomes = run_concurrent(specs, options.stagger);
    let mut failed = false;
    for outcome in outcomes {
        let expected = if outcome.id == "actor-a" {
            "fib.py"
        } else {
            "prime.py"
        };
        let verification = if outcome.status == "success" {
            verify_workspace(&outcome.workspace, Some(expected))
        } else {
            Err("agent run failed".to_owned())
        };
        failed |= outcome.status != "success" || verification.is_err();
        print_outcome(&outcome, verification);
    }
    println!("wall time: {:.1}s", started.elapsed().as_secs_f64());
    if failed {
        Err("one or more local agents failed".to_owned())
    } else {
        Ok(())
    }
}

fn run_benchmark(options: &Options) -> Result<(), String> {
    fs::create_dir_all(&options.workspace_root)
        .map_err(|error| format!("cannot create workspace root: {error}"))?;
    let (model, provider) = configured_provider(&options.base_url)?;
    let run_stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("cannot create benchmark run identity: {error}"))?
        .as_nanos();
    let benchmark_root = options
        .workspace_root
        .join("benchmark")
        .join(format!("run-{}-{run_stamp}", std::process::id()));
    println!("benchmark: local oMLX / Laguna XS 2.1");
    println!("endpoint: {}", options.base_url);
    println!("levels: {:?}; repeats: {}", options.levels, options.repeats);
    for repeat in 1..=options.repeats {
        for &concurrency in &options.levels {
            let wave_root = benchmark_root
                .join(format!("repeat-{repeat}"))
                .join(format!("concurrency-{concurrency}"));
            let specs = (0..concurrency)
                .map(|index| {
                    let id = format!("actor-{}", index + 1);
                    ActorSpec {
                        workspace: wave_root.join(&id),
                        instruction: task_for(options.workload, &id),
                        id,
                        model: model.clone(),
                        provider: Arc::clone(&provider),
                        timeout: options.timeout,
                    }
                })
                .collect();
            let started = Instant::now();
            let outcomes = run_concurrent(specs, options.stagger);
            let mut passed = 0;
            for outcome in &outcomes {
                let expected = if options.workload == Workload::Programming {
                    Some("intervals.py")
                } else {
                    None
                };
                let verification = if outcome.status == "success" {
                    verify_workspace(&outcome.workspace, expected)
                } else {
                    Err("agent run failed".to_owned())
                };
                if outcome.status == "success" && verification.is_ok() {
                    passed += 1;
                }
                if options.keep {
                    print_outcome(outcome, verification);
                }
            }
            let elapsed = started.elapsed();
            println!(
                "repeat {repeat}, concurrency {concurrency}: {passed}/{concurrency} passed in {:.1}s (active peak {concurrency})",
                elapsed.as_secs_f64()
            );
            if passed != concurrency {
                return Err(format!(
                    "benchmark stopped at repeat {repeat}, concurrency {concurrency}"
                ));
            }
        }
    }
    if !options.keep {
        fs::remove_dir_all(&benchmark_root)
            .map_err(|error| format!("cannot remove generated benchmark workspace: {error}"))?;
    }
    Ok(())
}

fn main() {
    let result = Options::parse().and_then(|options| match options.mode {
        Mode::Poc => run_poc(&options),
        Mode::Benchmark => run_benchmark(&options),
    });
    if let Err(error) = result {
        eprintln!("localswarm failed: {error}");
        std::process::exit(1);
    }
}
