use crate::commands::{
    CreateSessionRequest, CreateWorktreeRequest, KillSessionRequest, OpenTerminalRequest,
    PreviewWorktreeBaseRefRequest, PreviewWorktreeLaunchContextRequest,
};
use crate::runtime::{load_runtime_config, RuntimeConfig, OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use wait_timeout::ChildExt;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const ACTION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct CommandError {
    public_message: String,
    detail: Option<String>,
}

impl CommandError {
    pub fn new(public_message: impl Into<String>) -> Self {
        Self {
            public_message: public_message.into(),
            detail: None,
        }
    }

    pub fn with_detail(public_message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            public_message: public_message.into(),
            detail: Some(detail.into()),
        }
    }

    pub fn into_public_message(self) -> String {
        if let Some(detail) = self.detail {
            eprintln!("{detail}");
        }
        self.public_message
    }
}

pub fn load_snapshot() -> Result<Value, CommandError> {
    let runtime_config = load_config_for_command()?;
    let output = run_helper(
        &runtime_config,
        HelperSpec {
            script_path: &runtime_config.snapshot_helper_path,
            stdin_payload: None,
            timeout: SNAPSHOT_TIMEOUT,
            bridge_socket_path: None,
            public_error_message:
                "Session Deck snapshot is unavailable. Open desktop diagnostics for details.",
        },
    )?;

    if !output.success {
        return Err(CommandError::with_detail(
            "Session Deck snapshot is unavailable. Open desktop diagnostics for details.",
            format!(
                "Snapshot helper exited with a non-zero status. {}",
                format_process_detail(&output.stdout, &output.stderr)
            ),
        ));
    }

    parse_json_object(
        &output.stdout,
        "Session Deck snapshot helper returned invalid JSON.",
        "snapshot-helper-invalid-json",
    )
}

pub fn preview_worktree_base_ref(
    request: PreviewWorktreeBaseRefRequest,
) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        json!({
            "action": "preview-base-ref",
            "repoIntent": request.repo_intent,
        }),
        "Create-worktree preview is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn preview_worktree_launch_context(
    request: PreviewWorktreeLaunchContextRequest,
) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        json!({
            "action": "preview-launch-context",
            "launch": request.launch,
        }),
        "Pi config preview is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn create_worktree(request: CreateWorktreeRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        serde_json::to_value(&request).map_err(|error| {
            CommandError::with_detail(
                "Create-worktree request is invalid.",
                format!("Could not serialize the worktree request: {error}"),
            )
        })?,
        "Create-worktree action is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn create_session(request: CreateSessionRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        serde_json::to_value(&request).map_err(|error| {
            CommandError::with_detail(
                "Create-session request is invalid.",
                format!("Could not serialize the create-session request: {error}"),
            )
        })?,
        "Create-session action is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn open_terminal(request: OpenTerminalRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.open_action_helper_path,
        serde_json::to_value(&request).map_err(|error| {
            CommandError::with_detail(
                "Open-terminal request is invalid.",
                format!("Could not serialize the open-terminal request: {error}"),
            )
        })?,
        "Open-terminal action is unavailable. Open desktop diagnostics for details.",
    )
}

pub fn kill_session(request: KillSessionRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let runtime_config = load_config_for_command()?;
    run_action_helper(
        &runtime_config,
        &runtime_config.kill_action_helper_path,
        serde_json::to_value(&request).map_err(|error| {
            CommandError::with_detail(
                "End-session request is invalid.",
                format!("Could not serialize the end-session request: {error}"),
            )
        })?,
        "End-session action is unavailable. Open desktop diagnostics for details.",
    )
}

fn load_config_for_command() -> Result<RuntimeConfig, CommandError> {
    load_runtime_config().map_err(|detail| {
        CommandError::with_detail(
            "Session Deck desktop runtime is unavailable. Open desktop diagnostics for details.",
            detail,
        )
    })
}

fn run_action_helper(
    runtime_config: &RuntimeConfig,
    script_path: &std::path::Path,
    payload: Value,
    public_error_message: &str,
) -> Result<Value, CommandError> {
    let output = run_helper(
        runtime_config,
        HelperSpec {
            script_path,
            stdin_payload: Some(serde_json::to_vec(&payload).map_err(|error| {
                CommandError::with_detail(
                    public_error_message,
                    format!("Could not encode JSON payload: {error}"),
                )
            })?),
            timeout: ACTION_TIMEOUT,
            bridge_socket_path: if script_path == runtime_config.open_action_helper_path.as_path() {
                Some(runtime_config.bridge_socket_path.as_path())
            } else {
                None
            },
            public_error_message,
        },
    )?;

    let parsed = parse_json_object(
        &output.stdout,
        public_error_message,
        "action-helper-invalid-json",
    )?;

    if output.success {
        return Ok(parsed);
    }

    Ok(parsed)
}

fn parse_json_object(
    stdout: &str,
    public_error_message: &str,
    detail_code: &str,
) -> Result<Value, CommandError> {
    let parsed: Value = serde_json::from_str(stdout).map_err(|error| {
        CommandError::with_detail(
            public_error_message,
            format!("{detail_code}: could not parse helper stdout as JSON: {error}"),
        )
    })?;

    if !parsed.is_object() {
        return Err(CommandError::with_detail(
            public_error_message,
            format!("{detail_code}: helper stdout was not a JSON object."),
        ));
    }

    Ok(parsed)
}

struct HelperSpec<'a> {
    script_path: &'a std::path::Path,
    stdin_payload: Option<Vec<u8>>,
    timeout: Duration,
    bridge_socket_path: Option<&'a std::path::Path>,
    public_error_message: &'a str,
}

struct HelperOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

type PipeReader = JoinHandle<std::io::Result<Vec<u8>>>;

struct HelperOutputReaders {
    stdout: PipeReader,
    stderr: PipeReader,
}

fn run_helper(
    runtime_config: &RuntimeConfig,
    helper_spec: HelperSpec<'_>,
) -> Result<HelperOutput, CommandError> {
    let mut command = Command::new(&runtime_config.node_executable_path);
    command
        .arg(helper_spec.script_path)
        .stdin(if helper_spec.stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", &runtime_config.effective_command_path.value);

    if let Some(bridge_socket_path) = helper_spec.bridge_socket_path {
        command.env(
            OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV,
            bridge_socket_path.as_os_str(),
        );
    }

    let mut child = command.spawn().map_err(|error| {
        CommandError::with_detail(
            helper_spec.public_error_message,
            format!(
                "Could not spawn helper {} with node {}: {error}",
                helper_spec.script_path.display(),
                runtime_config.node_executable_path.display()
            ),
        )
    })?;

    let output_readers = match spawn_output_readers(&mut child, helper_spec.public_error_message) {
        Ok(readers) => readers,
        Err(error) => {
            terminate_child(&mut child);
            return Err(error);
        }
    };

    if let Some(stdin_payload) = helper_spec.stdin_payload {
        if let Err(error) = write_helper_stdin(
            &mut child,
            &stdin_payload,
            helper_spec.public_error_message,
        ) {
            terminate_child(&mut child);
            return Err(error);
        }
    }

    match child.wait_timeout(helper_spec.timeout) {
        Ok(Some(status)) => {
            let (stdout, stderr) =
                collect_helper_output(output_readers, helper_spec.public_error_message)?;

            Ok(HelperOutput {
                success: status.success(),
                stdout,
                stderr,
            })
        }
        Ok(None) => {
            terminate_child(&mut child);
            Err(CommandError::with_detail(
                helper_spec.public_error_message,
                format!(
                    "Helper process timed out after {} seconds.",
                    helper_spec.timeout.as_secs()
                ),
            ))
        }
        Err(error) => {
            terminate_child(&mut child);
            Err(CommandError::with_detail(
                helper_spec.public_error_message,
                format!("Could not wait for helper completion: {error}"),
            ))
        }
    }
}

fn spawn_output_readers(
    child: &mut Child,
    public_error_message: &str,
) -> Result<HelperOutputReaders, CommandError> {
    let stdout = child.stdout.take().ok_or_else(|| {
        CommandError::with_detail(
            public_error_message,
            "Helper stdout was not available after spawning the process.",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CommandError::with_detail(
            public_error_message,
            "Helper stderr was not available after spawning the process.",
        )
    })?;

    Ok(HelperOutputReaders {
        stdout: read_pipe_in_thread(stdout),
        stderr: read_pipe_in_thread(stderr),
    })
}

fn read_pipe_in_thread<R>(mut pipe: R) -> PipeReader
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = Vec::new();
        pipe.read_to_end(&mut output)?;
        Ok(output)
    })
}

fn write_helper_stdin(
    child: &mut Child,
    stdin_payload: &[u8],
    public_error_message: &str,
) -> Result<(), CommandError> {
    let mut stdin = child.stdin.take().ok_or_else(|| {
        CommandError::with_detail(
            public_error_message,
            "Helper stdin was not available after spawning the process.",
        )
    })?;

    stdin.write_all(stdin_payload).map_err(|error| {
        CommandError::with_detail(
            public_error_message,
            format!("Could not write helper stdin payload: {error}"),
        )
    })
}

fn collect_helper_output(
    output_readers: HelperOutputReaders,
    public_error_message: &str,
) -> Result<(String, String), CommandError> {
    Ok((
        collect_pipe_output(output_readers.stdout, "stdout", public_error_message)?,
        collect_pipe_output(output_readers.stderr, "stderr", public_error_message)?,
    ))
}

fn collect_pipe_output(
    reader: PipeReader,
    stream_name: &str,
    public_error_message: &str,
) -> Result<String, CommandError> {
    let bytes = reader
        .join()
        .map_err(|_| {
            CommandError::with_detail(
                public_error_message,
                format!("Helper {stream_name} reader panicked."),
            )
        })?
        .map_err(|error| {
            CommandError::with_detail(
                public_error_message,
                format!("Could not read helper {stream_name}: {error}"),
            )
        })?;

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn format_process_detail(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();

    if !stderr.is_empty() {
        return format!("stderr: {stderr}");
    }

    if !stdout.is_empty() {
        return format!("stdout: {stdout}");
    }

    String::from("no stdout or stderr was captured")
}

#[cfg(test)]
mod tests {
    use super::{run_helper, HelperSpec};
    use crate::runtime::{EffectiveCommandPath, RuntimeConfig, RuntimeMetadataSource};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn run_helper_drains_large_stdout_before_waiting_for_exit() {
        let temp_dir = tempdir().unwrap();
        let node_shim_path = temp_dir.path().join("node-shim");
        fs::write(
            &node_shim_path,
            "#!/bin/sh\ndd if=/dev/zero bs=1024 count=256 2>/dev/null\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&node_shim_path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&node_shim_path, permissions).unwrap();

        let script_path = temp_dir.path().join("ignored-helper.js");
        fs::write(&script_path, "").unwrap();
        let runtime_config = runtime_config_for_test(temp_dir.path(), node_shim_path);

        let output = run_helper(
            &runtime_config,
            HelperSpec {
                script_path: &script_path,
                stdin_payload: None,
                timeout: Duration::from_secs(2),
                bridge_socket_path: None,
                public_error_message: "helper failed",
            },
        )
        .unwrap();

        assert!(output.success);
        assert_eq!(output.stdout.as_bytes().len(), 256 * 1024);
        assert_eq!(output.stderr, "");
    }

    fn runtime_config_for_test(root: &Path, node_executable_path: PathBuf) -> RuntimeConfig {
        RuntimeConfig {
            metadata_source: RuntimeMetadataSource::Desktop,
            state_path: root.join("install.json"),
            package_root: root.to_path_buf(),
            package_version: String::from("0.0.0-test"),
            helper_package_version: Some(String::from("0.0.0-test")),
            node_executable_path,
            snapshot_helper_path: root.join("snapshot-helper.js"),
            open_action_helper_path: root.join("open-action-helper.js"),
            kill_action_helper_path: root.join("kill-action-helper.js"),
            worktree_action_helper_path: root.join("worktree-action-helper.js"),
            web_root_path: root.join("web"),
            bridge_socket_path: root.join("bridge.sock"),
            effective_command_path: EffectiveCommandPath {
                value: std::env::var("PATH").unwrap_or_else(|_| String::from("/usr/bin:/bin")),
                provenance: String::from("test"),
            },
        }
    }
}
