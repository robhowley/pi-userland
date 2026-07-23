import { doctorSessionDeckDesktopInstall } from './doctor.js';
import { installSessionDeckDesktop } from './install.js';
import { openSessionDeckDesktop } from './open.js';
import { uninstallSessionDeckDesktop } from './uninstall.js';
import {
  SESSION_DECK_DESKTOP_DOCTOR_ACTION,
  SESSION_DECK_DESKTOP_FROM_PATH_FLAG,
  SESSION_DECK_DESKTOP_INSTALL_ACTION,
  SESSION_DECK_DESKTOP_OPEN_ACTION,
  SESSION_DECK_DESKTOP_SHA256_FLAG,
  SESSION_DECK_DESKTOP_SUBCOMMAND,
  SESSION_DECK_DESKTOP_UNINSTALL_ACTION,
  SESSION_DECK_DESKTOP_VERSION_FLAG,
} from './paths.js';

export const SESSION_DECK_DESKTOP_COMMAND_USAGE =
  'Usage: /session-deck desktop install [--from-path <Session Deck.app|zip|dmg>] [--version <version>] [--sha256 <sha256>] | /session-deck desktop <open|uninstall|doctor>';

export interface SessionDeckDesktopCommandResult {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface RunSessionDeckDesktopCommandOptions {
  doctor?: typeof doctorSessionDeckDesktopInstall;
  install?: typeof installSessionDeckDesktop;
  open?: typeof openSessionDeckDesktop;
  uninstall?: typeof uninstallSessionDeckDesktop;
}

export type ParsedSessionDeckDesktopCommandArgs =
  | {
      ok: true;
      action: 'install';
      fromPath?: string;
      version?: string;
      sha256?: string;
    }
  | {
      ok: true;
      action: 'open' | 'uninstall' | 'doctor';
    }
  | {
      ok: false;
      message: string;
    };

const SESSION_DECK_DESKTOP_ACTIONS = [
  SESSION_DECK_DESKTOP_INSTALL_ACTION,
  SESSION_DECK_DESKTOP_OPEN_ACTION,
  SESSION_DECK_DESKTOP_UNINSTALL_ACTION,
  SESSION_DECK_DESKTOP_DOCTOR_ACTION,
] as const;
const SESSION_DECK_DESKTOP_INSTALL_FLAGS = [
  SESSION_DECK_DESKTOP_FROM_PATH_FLAG,
  SESSION_DECK_DESKTOP_VERSION_FLAG,
  SESSION_DECK_DESKTOP_SHA256_FLAG,
] as const;

export function isSessionDeckDesktopCommand(args: string): boolean {
  const trimmedArgs = args.trim();
  return (
    trimmedArgs === SESSION_DECK_DESKTOP_SUBCOMMAND ||
    trimmedArgs.startsWith(`${SESSION_DECK_DESKTOP_SUBCOMMAND} `)
  );
}

export async function runSessionDeckDesktopCommand(
  args: string,
  options: RunSessionDeckDesktopCommandOptions = {},
): Promise<SessionDeckDesktopCommandResult> {
  const parsedArgs = parseSessionDeckDesktopCommandArgs(args);
  if (!parsedArgs.ok) {
    return { level: 'error', message: parsedArgs.message };
  }

  switch (parsedArgs.action) {
    case 'install':
      return (options.install ?? installSessionDeckDesktop)({
        ...(parsedArgs.fromPath === undefined ? {} : { fromPath: parsedArgs.fromPath }),
        ...(parsedArgs.version === undefined ? {} : { version: parsedArgs.version }),
        ...(parsedArgs.sha256 === undefined ? {} : { sha256: parsedArgs.sha256 }),
      });
    case 'open':
      return (options.open ?? openSessionDeckDesktop)({});
    case 'uninstall':
      return (options.uninstall ?? uninstallSessionDeckDesktop)({});
    case 'doctor':
      return (options.doctor ?? doctorSessionDeckDesktopInstall)({});
  }
}

export function parseSessionDeckDesktopCommandArgs(
  args: string,
): ParsedSessionDeckDesktopCommandArgs {
  const tokenizedArgs = tokenizeSessionDeckDesktopCommandArgs(args);
  if (!tokenizedArgs.ok) {
    return createUsageError(tokenizedArgs.message);
  }
  const tokens = tokenizedArgs.tokens;

  if (tokens[0] !== SESSION_DECK_DESKTOP_SUBCOMMAND) {
    return createUsageError(`Unsupported argument: ${tokens[0] ?? '<empty>'}`);
  }

  const actionToken = tokens[1];
  if (
    !SESSION_DECK_DESKTOP_ACTIONS.includes(
      actionToken as (typeof SESSION_DECK_DESKTOP_ACTIONS)[number],
    )
  ) {
    return createUsageError(
      actionToken === undefined
        ? 'Missing desktop action'
        : `Unsupported desktop action: ${actionToken}`,
    );
  }

  if (actionToken !== SESSION_DECK_DESKTOP_INSTALL_ACTION) {
    const extraToken = tokens[2];
    if (extraToken !== undefined) {
      return createUsageError(
        (SESSION_DECK_DESKTOP_INSTALL_FLAGS as readonly string[]).includes(extraToken)
          ? `${extraToken} is only supported for desktop install`
          : `Unsupported argument: ${extraToken}`,
      );
    }

    return {
      ok: true,
      action: actionToken as 'open' | 'uninstall' | 'doctor',
    };
  }

  const parsedFlags = parseInstallFlags(tokens.slice(2));
  if (!parsedFlags.ok) {
    return parsedFlags;
  }

  return {
    ok: true,
    action: SESSION_DECK_DESKTOP_INSTALL_ACTION,
    ...(parsedFlags.fromPath === undefined ? {} : { fromPath: parsedFlags.fromPath }),
    ...(parsedFlags.version === undefined ? {} : { version: parsedFlags.version }),
    ...(parsedFlags.sha256 === undefined ? {} : { sha256: parsedFlags.sha256 }),
  };
}

export function getSessionDeckDesktopCommandCompletions(prefix: string) {
  const trimmedPrefix = prefix.trimStart();
  if (trimmedPrefix.length === 0) {
    return [{ value: SESSION_DECK_DESKTOP_SUBCOMMAND, label: SESSION_DECK_DESKTOP_SUBCOMMAND }];
  }

  if (!trimmedPrefix.startsWith(SESSION_DECK_DESKTOP_SUBCOMMAND)) {
    const matches = [SESSION_DECK_DESKTOP_SUBCOMMAND]
      .filter((value) => value.startsWith(trimmedPrefix))
      .map((value) => ({ value, label: value }));
    return matches.length > 0 ? matches : null;
  }

  const remainder = trimmedPrefix.slice(SESSION_DECK_DESKTOP_SUBCOMMAND.length).trimStart();
  if (remainder.length === 0) {
    return SESSION_DECK_DESKTOP_ACTIONS.map((value) => ({
      value: `${SESSION_DECK_DESKTOP_SUBCOMMAND} ${value}`,
      label: value,
    }));
  }

  const segments = remainder.split(/\s+/).filter((token) => token.length > 0);
  if (segments.length === 1 && !remainder.endsWith(' ')) {
    const matches = SESSION_DECK_DESKTOP_ACTIONS.filter((value) =>
      value.startsWith(segments[0]!),
    ).map((value) => ({
      value: `${SESSION_DECK_DESKTOP_SUBCOMMAND} ${value}`,
      label: value,
    }));
    return matches.length > 0 ? matches : null;
  }

  if (segments[0] !== SESSION_DECK_DESKTOP_INSTALL_ACTION) {
    return null;
  }

  const flagPrefix = remainder.endsWith(' ') ? '' : (segments[segments.length - 1] ?? '');
  if (SESSION_DECK_DESKTOP_INSTALL_FLAGS.some((flag) => flagPrefix === flag)) {
    return null;
  }

  const usedFlags = new Set(
    segments.filter((segment): segment is (typeof SESSION_DECK_DESKTOP_INSTALL_FLAGS)[number] =>
      (SESSION_DECK_DESKTOP_INSTALL_FLAGS as readonly string[]).includes(segment),
    ),
  );
  const matches = SESSION_DECK_DESKTOP_INSTALL_FLAGS.filter(
    (value) => !usedFlags.has(value) && value.startsWith(flagPrefix),
  ).map((value) => ({
    value: `${trimmedPrefix.replace(/\s+$/u, '')} ${value}`.trim(),
    label: value,
  }));
  return matches.length > 0 ? matches : null;
}

function parseInstallFlags(
  tokens: string[],
):
  | Extract<ParsedSessionDeckDesktopCommandArgs, { ok: true; action: 'install' }>
  | { ok: false; message: string } {
  let fromPath: string | undefined;
  let version: string | undefined;
  let sha256: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!(SESSION_DECK_DESKTOP_INSTALL_FLAGS as readonly string[]).includes(token)) {
      return createUsageError(`Unsupported argument: ${token}`);
    }

    if (token === SESSION_DECK_DESKTOP_FROM_PATH_FLAG) {
      if (fromPath !== undefined) {
        return createUsageError(`Duplicate flag: ${SESSION_DECK_DESKTOP_FROM_PATH_FLAG}`);
      }
      const value = tokens[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return createUsageError(`Missing value for ${SESSION_DECK_DESKTOP_FROM_PATH_FLAG}`);
      }
      fromPath = value;
      index += 1;
      continue;
    }

    if (token === SESSION_DECK_DESKTOP_VERSION_FLAG) {
      if (version !== undefined) {
        return createUsageError(`Duplicate flag: ${SESSION_DECK_DESKTOP_VERSION_FLAG}`);
      }
      const value = tokens[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return createUsageError(`Missing value for ${SESSION_DECK_DESKTOP_VERSION_FLAG}`);
      }
      version = value;
      index += 1;
      continue;
    }

    if (sha256 !== undefined) {
      return createUsageError(`Duplicate flag: ${SESSION_DECK_DESKTOP_SHA256_FLAG}`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return createUsageError(`Missing value for ${SESSION_DECK_DESKTOP_SHA256_FLAG}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(value)) {
      return createUsageError(
        `${SESSION_DECK_DESKTOP_SHA256_FLAG} must be a lowercase SHA-256 hash`,
      );
    }
    sha256 = value;
    index += 1;
  }

  return {
    ok: true,
    action: SESSION_DECK_DESKTOP_INSTALL_ACTION,
    ...(fromPath === undefined ? {} : { fromPath }),
    ...(version === undefined ? {} : { version }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

function tokenizeSessionDeckDesktopCommandArgs(
  args: string,
): { ok: true; tokens: string[] } | { ok: false; message: string } {
  const tokens: string[] = [];
  let currentToken = '';
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const character of args.trim()) {
    if (escaping) {
      currentToken += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote !== null) {
      if (character === quote) {
        quote = null;
        continue;
      }
      currentToken += character;
      tokenStarted = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        tokens.push(currentToken);
        currentToken = '';
        tokenStarted = false;
      }
      continue;
    }

    currentToken += character;
    tokenStarted = true;
  }

  if (escaping) {
    currentToken += '\\';
  }

  if (quote !== null) {
    return { ok: false, message: 'Unterminated quoted argument' };
  }

  if (tokenStarted) {
    tokens.push(currentToken);
  }

  return { ok: true, tokens };
}

function createUsageError(message: string): { ok: false; message: string } {
  return {
    ok: false,
    message: `${message}. ${SESSION_DECK_DESKTOP_COMMAND_USAGE}`,
  };
}
