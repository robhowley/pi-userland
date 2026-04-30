export type ParsedFailure = {
  id: string;
  file?: string;
  line?: number;
  message?: string;
  rule?: string;
};

export type ParsedResult = {
  tool: string;
  exitCode: number;
  status: "pass" | "fail" | "error";
  summary: string;
  cwd?: string;
  failures?: ParsedFailure[];
  logPath?: string;
  rawTail?: string;
};

export type ObservedRunArgs = {
  command: string;
  cwd?: string;
  parseAs?: string;
  artifactPaths?: string[];
};

export type RunContext = {
  command: string;
  argv: string[];
  cwd: string;
  artifactPaths: string[];
  stdoutPath: string;
  stderrPath: string;
  logPath: string;
};

export type ParserModule = {
  id: string;
  parse: (ctx: RunContext) => Promise<Omit<ParsedResult, "exitCode">>;
};

export type ParserRegistration = {
  id: string;
  match?: {
    argvIncludes?: string[];
    regex?: string;
  };
  parseAs?: string;
  module?: string;
};

export type ParserConfigFile = {
  parsers: ParserRegistration[];
};
