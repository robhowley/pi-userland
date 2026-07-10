import { doctorSessionDeckIterm2Install } from './doctor.js';
import { installSessionDeckIterm2 } from './install.js';
import {
  SESSION_DECK_ITERM2_DOCTOR_ACTION,
  SESSION_DECK_ITERM2_INSTALL_ACTION,
  SESSION_DECK_ITERM2_SCRIPTS_DIR_FLAG,
  SESSION_DECK_ITERM2_SUBCOMMAND,
  SESSION_DECK_ITERM2_UNINSTALL_ACTION,
} from './paths.js';
import { uninstallSessionDeckIterm2 } from './uninstall.js';

export const SESSION_DECK_ITERM2_COMMAND_USAGE =
  'Usage: /session-deck iterm2 <install|uninstall|doctor> [--scripts-dir <path>]';

export interface SessionDeckIterm2CommandResult {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface RunSessionDeckIterm2CommandOptions {
  doctor?: typeof doctorSessionDeckIterm2Install;
  install?: typeof installSessionDeckIterm2;
  uninstall?: typeof uninstallSessionDeckIterm2;
}

export type ParsedSessionDeckIterm2CommandArgs =
  | {
      ok: true;
      action: 'install' | 'uninstall' | 'doctor';
      scriptsDir?: string;
    }
  | {
      ok: false;
      message: string;
    };

export function isSessionDeckIterm2Command(args: string): boolean {
  const trimmedArgs = args.trim();
  return (
    trimmedArgs === SESSION_DECK_ITERM2_SUBCOMMAND ||
    trimmedArgs.startsWith(`${SESSION_DECK_ITERM2_SUBCOMMAND} `)
  );
}

export async function runSessionDeckIterm2Command(
  args: string,
  options: RunSessionDeckIterm2CommandOptions = {},
): Promise<SessionDeckIterm2CommandResult> {
  const parsedArgs = parseSessionDeckIterm2CommandArgs(args);
  if (!parsedArgs.ok) {
    return { level: 'error', message: parsedArgs.message };
  }

  switch (parsedArgs.action) {
    case 'install':
      return (options.install ?? installSessionDeckIterm2)({
        ...(parsedArgs.scriptsDir === undefined ? {} : { scriptsDir: parsedArgs.scriptsDir }),
      });
    case 'uninstall':
      return (options.uninstall ?? uninstallSessionDeckIterm2)({
        ...(parsedArgs.scriptsDir === undefined ? {} : { scriptsDir: parsedArgs.scriptsDir }),
      });
    case 'doctor':
      return (options.doctor ?? doctorSessionDeckIterm2Install)({
        ...(parsedArgs.scriptsDir === undefined ? {} : { scriptsDir: parsedArgs.scriptsDir }),
      });
  }
}

const SESSION_DECK_ITERM2_ACTIONS = [
  SESSION_DECK_ITERM2_INSTALL_ACTION,
  SESSION_DECK_ITERM2_UNINSTALL_ACTION,
  SESSION_DECK_ITERM2_DOCTOR_ACTION,
] as const;

export function parseSessionDeckIterm2CommandArgs(
  args: string,
): ParsedSessionDeckIterm2CommandArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  if (tokens[0] !== SESSION_DECK_ITERM2_SUBCOMMAND) {
    return createUsageError(`Unsupported argument: ${tokens[0] ?? '<empty>'}`);
  }

  const actionToken = tokens[1];
  if (
    !SESSION_DECK_ITERM2_ACTIONS.includes(
      actionToken as (typeof SESSION_DECK_ITERM2_ACTIONS)[number],
    )
  ) {
    return createUsageError(
      actionToken === undefined
        ? 'Missing iterm2 action'
        : `Unsupported iterm2 action: ${actionToken}`,
    );
  }

  let scriptsDir: string | undefined;

  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token !== SESSION_DECK_ITERM2_SCRIPTS_DIR_FLAG) {
      return createUsageError(`Unsupported argument: ${token}`);
    }

    if (scriptsDir !== undefined) {
      return createUsageError(`Duplicate flag: ${SESSION_DECK_ITERM2_SCRIPTS_DIR_FLAG}`);
    }

    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return createUsageError(`Missing value for ${SESSION_DECK_ITERM2_SCRIPTS_DIR_FLAG}`);
    }

    scriptsDir = value;
    index += 1;
  }

  return {
    ok: true,
    action: actionToken as (typeof SESSION_DECK_ITERM2_ACTIONS)[number],
    ...(scriptsDir === undefined ? {} : { scriptsDir }),
  };
}

export function getSessionDeckIterm2CommandCompletions(prefix: string) {
  const trimmedPrefix = prefix.trimStart();
  if (trimmedPrefix.length === 0) {
    return [{ value: SESSION_DECK_ITERM2_SUBCOMMAND, label: SESSION_DECK_ITERM2_SUBCOMMAND }];
  }

  if (!trimmedPrefix.startsWith(SESSION_DECK_ITERM2_SUBCOMMAND)) {
    const matches = [SESSION_DECK_ITERM2_SUBCOMMAND]
      .filter((value) => value.startsWith(trimmedPrefix))
      .map((value) => ({ value, label: value }));
    return matches.length > 0 ? matches : null;
  }

  const remainder = trimmedPrefix.slice(SESSION_DECK_ITERM2_SUBCOMMAND.length).trimStart();
  if (remainder.length === 0) {
    return SESSION_DECK_ITERM2_ACTIONS.map((value) => ({
      value: `${SESSION_DECK_ITERM2_SUBCOMMAND} ${value}`,
      label: value,
    }));
  }

  const segments = remainder.split(/\s+/).filter((token) => token.length > 0);
  if (segments.length === 1 && !remainder.endsWith(' ')) {
    const matches = SESSION_DECK_ITERM2_ACTIONS.filter((value) =>
      value.startsWith(segments[0]!),
    ).map((value) => ({
      value: `${SESSION_DECK_ITERM2_SUBCOMMAND} ${value}`,
      label: value,
    }));
    return matches.length > 0 ? matches : null;
  }

  const flagPrefix = remainder.endsWith(' ') ? '' : (segments[segments.length - 1] ?? '');
  if (segments.includes(SESSION_DECK_ITERM2_SCRIPTS_DIR_FLAG)) {
    return null;
  }

  const matches = [SESSION_DECK_ITERM2_SCRIPTS_DIR_FLAG]
    .filter((value) => value.startsWith(flagPrefix))
    .map((value) => ({
      value: `${trimmedPrefix.replace(/\s+$/u, '')} ${value}`.trim(),
      label: value,
    }));
  return matches.length > 0 ? matches : null;
}

function createUsageError(message: string): ParsedSessionDeckIterm2CommandArgs {
  return {
    ok: false,
    message: `${message}. ${SESSION_DECK_ITERM2_COMMAND_USAGE}`,
  };
}
