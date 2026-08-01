use crate::commands::{
    CreateSessionRequest, CreateWorktreeRequest, KillSessionRequest, OpenTerminalRequest,
    PreviewWorktreeBaseRefRequest, PreviewWorktreeLaunchContextRequest, RestartSessionRequest,
};
use crate::runtime::{load_runtime_config, RuntimeConfig, OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use wait_timeout::ChildExt;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const ACTION_TIMEOUT: Duration = Duration::from_secs(60);
const MUTATING_HELPER_TIMEOUT_CODE: &str = "mutating-helper-timeout";
const MUTATING_HELPER_TIMEOUT_MESSAGE: &str =
    "The desktop helper timed out before Session Deck could confirm whether the action completed.";

#[derive(Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CommandErrorPayload {
    Message(String),
    OutcomeUnknown {
        code: &'static str,
        message: &'static str,
        #[serde(rename = "outcomeUnknown")]
        outcome_unknown: bool,
    },
}

#[derive(Debug)]
pub struct CommandError {
    payload: CommandErrorPayload,
    detail: Option<String>,
}

impl CommandError {
    pub fn new(public_message: impl Into<String>) -> Self {
        Self {
            payload: CommandErrorPayload::Message(public_message.into()),
            detail: None,
        }
    }

    pub fn with_detail(public_message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            payload: CommandErrorPayload::Message(public_message.into()),
            detail: Some(detail.into()),
        }
    }

    fn timeout(timeout: Duration, outcome_unknown: bool, public_message: &str) -> Self {
        let payload = if outcome_unknown {
            CommandErrorPayload::OutcomeUnknown {
                code: MUTATING_HELPER_TIMEOUT_CODE,
                message: MUTATING_HELPER_TIMEOUT_MESSAGE,
                outcome_unknown: true,
            }
        } else {
            CommandErrorPayload::Message(String::from(public_message))
        };

        Self {
            payload,
            detail: Some(format!(
                "Helper process timed out after {} seconds.",
                timeout.as_secs_f64()
            )),
        }
    }

    pub fn into_public_message(self) -> String {
        match self.into_tauri_error() {
            CommandErrorPayload::Message(message) => message,
            CommandErrorPayload::OutcomeUnknown { message, .. } => String::from(message),
        }
    }

    pub fn into_tauri_error(self) -> CommandErrorPayload {
        if let Some(detail) = self.detail {
            eprintln!("{detail}");
        }
        self.payload
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
            outcome_unknown_on_timeout: false,
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
        false,
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
        false,
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
        true,
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
        true,
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
        true,
    )
}

pub fn restart_session(request: RestartSessionRequest) -> Result<Value, CommandError> {
    request.validate()?;
    let operation_id = request.operation_id.clone();
    let runtime_config = load_config_for_command()?;
    match run_action_helper(
        &runtime_config,
        &runtime_config.worktree_action_helper_path,
        json!({
            "action": "restart-session",
            "runtimeId": request.runtime_id,
            "generation": request.generation,
            "operationId": request.operation_id,
        }),
        "Restart-session action is unavailable. Open desktop diagnostics for details.",
        true,
    ) {
        Ok(value) => validate_restart_session_result(value, &operation_id),
        Err(error) => map_restart_helper_error(error, &operation_id),
    }
}

fn map_restart_helper_error(
    error: CommandError,
    operation_id: &str,
) -> Result<Value, CommandError> {
    if matches!(&error.payload, CommandErrorPayload::OutcomeUnknown { .. }) {
        return Ok(restart_outcome_unknown(operation_id));
    }
    Err(error)
}

fn restart_outcome_unknown(operation_id: &str) -> Value {
    json!({
        "ok": false,
        "status": "outcome-unknown",
        "operationId": operation_id,
        "reason": "operation-state-unknown",
        "retryable": true,
        "message": "Session Deck could not confirm the restart outcome. Reconcile before retrying.",
    })
}

fn validate_restart_session_result(
    value: Value,
    expected_operation_id: &str,
) -> Result<Value, CommandError> {
    let Some(result) = value.as_object() else {
        return Err(invalid_restart_result());
    };
    let expected_keys = [
        "ok",
        "status",
        "operationId",
        "reason",
        "retryable",
        "message",
    ];
    if result.len() != expected_keys.len()
        || expected_keys.iter().any(|key| !result.contains_key(*key))
    {
        return Err(invalid_restart_result());
    }
    let status = result.get("status").and_then(Value::as_str);
    let reason = result.get("reason").and_then(Value::as_str);
    let retryable = result.get("retryable").and_then(Value::as_bool);
    let ok = result.get("ok").and_then(Value::as_bool);
    let operation_id = result.get("operationId").and_then(Value::as_str);
    if !matches!(
        operation_id,
        Some(value) if !value.is_empty() && value == expected_operation_id
    ) || result.get("message").and_then(Value::as_str).is_none()
        || !is_coherent_restart_result(status, reason, retryable, ok)
    {
        return Err(invalid_restart_result());
    }
    Ok(value)
}

fn is_coherent_restart_result(
    status: Option<&str>,
    reason: Option<&str>,
    retryable: Option<bool>,
    ok: Option<bool>,
) -> bool {
    // Keep this table aligned with restart domain outcomes; retain recipe-invalid for compatibility.
    matches!(
        (status, reason, retryable, ok),
        (
            Some("restarted"),
            Some("replacement-observed"),
            Some(false),
            Some(true)
        ) | (
            Some("not-eligible"),
            Some("managed-recipe-unavailable"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("recipe-not-bound"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("recipe-invalid"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("runtime-unavailable"),
            Some(true),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("identity-mismatch"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("session-file-unavailable"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("cwd-unavailable"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("pi-executable-unavailable"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("tmux-target-unavailable"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("tmux-pane-mismatch"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("unsafe-descendants"),
            Some(true),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("hosting-runtime"),
            Some(false),
            Some(false)
        ) | (
            Some("not-eligible"),
            Some("coordinator-runtime"),
            Some(false),
            Some(false)
        ) | (
            Some("stale-generation"),
            Some("generation-changed"),
            Some(false),
            Some(false)
        ) | (
            Some("already-in-progress"),
            Some("operation-in-progress"),
            Some(true),
            Some(false)
        ) | (
            Some("stop-failed"),
            Some("termination-failed"),
            Some(true),
            Some(false)
        ) | (
            Some("stop-failed"),
            Some("unsafe-descendants"),
            Some(true),
            Some(false)
        ) | (
            Some("stopped-not-restarted"),
            Some("pane-did-not-stop"),
            Some(true),
            Some(false)
        ) | (
            Some("stopped-not-restarted"),
            Some("tmux-target-unavailable"),
            Some(true),
            Some(false)
        ) | (
            Some("stopped-not-restarted"),
            Some("respawn-failed"),
            Some(true),
            Some(false)
        ) | (
            Some("outcome-unknown"),
            Some("replacement-unobserved"),
            Some(true),
            Some(false)
        ) | (
            Some("outcome-unknown"),
            Some("operation-state-unknown"),
            Some(true),
            Some(false)
        )
    )
}

fn invalid_restart_result() -> CommandError {
    CommandError::with_detail(
        "Restart-session action returned an invalid response.",
        "The helper response did not match the restart-session domain contract.",
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
        true,
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
    outcome_unknown_on_timeout: bool,
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
            outcome_unknown_on_timeout,
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
    outcome_unknown_on_timeout: bool,
}

#[derive(Debug)]
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

    // SAFETY: setpgid only changes the child process before exec and does not access parent memory.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

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
        if let Err(error) =
            write_helper_stdin(&mut child, &stdin_payload, helper_spec.public_error_message)
        {
            terminate_child(&mut child);
            return Err(error);
        }
    }

    match child.wait_timeout(helper_spec.timeout) {
        Ok(Some(status)) => {
            let (stdout, stderr) =
                match collect_helper_output(output_readers, helper_spec.public_error_message) {
                    Ok(output) => output,
                    Err(error) => {
                        terminate_child(&mut child);
                        return Err(error);
                    }
                };

            Ok(HelperOutput {
                success: status.success(),
                stdout,
                stderr,
            })
        }
        Ok(None) => {
            terminate_child(&mut child);
            Err(CommandError::timeout(
                helper_spec.timeout,
                helper_spec.outcome_unknown_on_timeout,
                helper_spec.public_error_message,
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
    let process_group = child.id() as libc::pid_t;
    // The direct child created this process group in pre_exec. Killing the group limits ordinary
    // descendants; detached processes and external effects such as tmux are outside this boundary.
    unsafe {
        let _ = libc::kill(-process_group, libc::SIGKILL);
    }
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
    use super::{
        is_coherent_restart_result, map_restart_helper_error, run_helper,
        validate_restart_session_result, CommandError, CommandErrorPayload, HelperSpec,
    };
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
                outcome_unknown_on_timeout: false,
            },
        )
        .unwrap();

        assert!(output.success);
        assert_eq!(output.stdout.as_bytes().len(), 256 * 1024);
        assert_eq!(output.stderr, "");
    }

    #[test]
    fn mutating_timeout_is_structured_and_terminates_same_group_descendants() {
        let temp_dir = tempdir().unwrap();
        let marker_path = temp_dir.path().join("delayed-marker");
        let node_shim_path = temp_dir.path().join("node-shim");
        fs::write(
            &node_shim_path,
            format!(
                "#!/bin/sh\n(sleep 0.2; printf late > '{}') &\nsleep 5\n",
                marker_path.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&node_shim_path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&node_shim_path, permissions).unwrap();

        let script_path = temp_dir.path().join("ignored-helper.js");
        fs::write(&script_path, "").unwrap();
        let runtime_config = runtime_config_for_test(temp_dir.path(), node_shim_path);

        let error = run_helper(
            &runtime_config,
            HelperSpec {
                script_path: &script_path,
                stdin_payload: None,
                timeout: Duration::from_millis(50),
                bridge_socket_path: None,
                public_error_message: "helper failed",
                outcome_unknown_on_timeout: true,
            },
        )
        .unwrap_err();

        assert_eq!(
            serde_json::to_value(error.into_tauri_error()).unwrap(),
            serde_json::json!({
                "code": "mutating-helper-timeout",
                "message": "The desktop helper timed out before Session Deck could confirm whether the action completed.",
                "outcomeUnknown": true
            })
        );
        std::thread::sleep(Duration::from_millis(350));
        assert!(!marker_path.exists());
    }

    #[test]
    fn restart_result_requires_the_exact_operation_and_domain_shape() {
        let valid = serde_json::json!({
            "ok": true,
            "status": "restarted",
            "operationId": "operation-1",
            "reason": "replacement-observed",
            "retryable": false,
            "message": "Session restarted."
        });
        assert!(validate_restart_session_result(valid.clone(), "operation-1").is_ok());
        assert!(validate_restart_session_result(valid.clone(), "operation-2").is_err());
        let mut private = valid;
        private["sessionFile"] = serde_json::json!("/private/session.jsonl");
        assert!(validate_restart_session_result(private, "operation-1").is_err());
    }

    #[test]
    fn restart_result_accepts_current_domain_tuples() {
        for (status, reason, retryable, ok) in [
            ("restarted", "replacement-observed", false, true),
            ("not-eligible", "managed-recipe-unavailable", false, false),
            ("not-eligible", "recipe-not-bound", false, false),
            ("not-eligible", "recipe-invalid", false, false),
            ("not-eligible", "runtime-unavailable", true, false),
            ("not-eligible", "identity-mismatch", false, false),
            ("not-eligible", "session-file-unavailable", false, false),
            ("not-eligible", "cwd-unavailable", false, false),
            ("not-eligible", "pi-executable-unavailable", false, false),
            ("not-eligible", "tmux-target-unavailable", false, false),
            ("not-eligible", "tmux-pane-mismatch", false, false),
            ("not-eligible", "unsafe-descendants", true, false),
            ("not-eligible", "hosting-runtime", false, false),
            ("not-eligible", "coordinator-runtime", false, false),
            ("stale-generation", "generation-changed", false, false),
            ("already-in-progress", "operation-in-progress", true, false),
            ("stop-failed", "termination-failed", true, false),
            ("stop-failed", "unsafe-descendants", true, false),
            ("stopped-not-restarted", "pane-did-not-stop", true, false),
            (
                "stopped-not-restarted",
                "tmux-target-unavailable",
                true,
                false,
            ),
            ("stopped-not-restarted", "respawn-failed", true, false),
            ("outcome-unknown", "replacement-unobserved", true, false),
            ("outcome-unknown", "operation-state-unknown", true, false),
        ] {
            assert!(is_coherent_restart_result(
                Some(status),
                Some(reason),
                Some(retryable),
                Some(ok)
            ));
        }
    }

    #[test]
    fn restart_result_rejects_incoherent_domain_tuples() {
        let valid = serde_json::json!({
            "ok": true,
            "status": "restarted",
            "operationId": "operation-1",
            "reason": "replacement-observed",
            "retryable": false,
            "message": "Session restarted."
        });

        for (field, value) in [
            ("status", serde_json::json!("outcome-unknown")),
            ("reason", serde_json::json!("termination-failed")),
            ("retryable", serde_json::json!(true)),
            ("ok", serde_json::json!(false)),
        ] {
            let mut candidate = valid.clone();
            candidate[field] = value;
            assert!(
                validate_restart_session_result(candidate, "operation-1").is_err(),
                "{field} should not change independently"
            );
        }
    }

    #[test]
    fn restart_timeout_result_echoes_only_the_existing_operation_id() {
        let result = map_restart_helper_error(
            CommandError::timeout(Duration::from_secs(60), true, "restart unavailable"),
            "operation-timeout",
        )
        .unwrap();
        assert!(validate_restart_session_result(result.clone(), "operation-timeout").is_ok());
        assert_eq!(
            result,
            serde_json::json!({
                "ok": false,
                "status": "outcome-unknown",
                "operationId": "operation-timeout",
                "reason": "operation-state-unknown",
                "retryable": true,
                "message": "Session Deck could not confirm the restart outcome. Reconcile before retrying."
            })
        );
    }

    #[test]
    fn read_only_timeout_remains_an_ordinary_error() {
        assert_eq!(
            CommandError::timeout(Duration::from_secs(10), false, "snapshot unavailable")
                .into_tauri_error(),
            CommandErrorPayload::Message(String::from("snapshot unavailable"))
        );
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
