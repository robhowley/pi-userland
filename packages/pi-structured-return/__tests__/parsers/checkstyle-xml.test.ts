import { describe, it, expect, beforeEach } from 'vitest';
import parser from '../../extensions/structured-return/parsers/checkstyle-xml';
import type { ParserModule, RunContext } from '../../extensions/structured-return/types';

describe('checkstyle-xml parser', () => {
  let ctx: RunContext;

  beforeEach(() => {
    ctx = {
      command: 'checkstyle -c config.xml src.java',
      argv: ['checkstyle', '-c', 'config.xml', 'src.java'],
      cwd: '/Users/roberthowley/src/test-project',
      artifactPaths: [],
      stdoutPath: '',
      stderrPath: '',
      logPath: '',
    };
  });

  const readFixture = (name: string): string => {
    const fs = require('fs');
    const path = require('path');
    return fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'checkstyle', name),
      'utf8'
    );
  };

  it('handles happy path with absolute path and FQCN source', async () => {
    const fixturePath = '/tmp/happy-path.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, readFixture('happy-path.xml'));

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.status).toBe('fail');
    expect(result.tool).toBe('checkstyle');
    expect(result.summary).toBe('2 findings (1 errors, 1 warnings)');

    expect(result.failures).toHaveLength(2);
    
    // First error: warning
    expect(result.failures[0].id).toContain('BarCheck.java:42');
    expect(result.failures[0].file).toBe('src/main/java/com/foo/BarCheck.java');
    expect(result.failures[0].line).toBe(42);
    expect(result.failures[0].message).toBe('Missing a Javadoc comment.');
    expect(result.failures[0].rule).toBe('JavadocMethodCheck');

    // Second error: error severity
    expect(result.failures[1].id).toContain('BarCheck.java:55');
    expect(result.failures[1].file).toBe('src/main/java/com/foo/BarCheck.java');
    expect(result.failures[1].line).toBe(55);
    expect(result.failures[1].message).toBe('Expected indent of 8 characters, found 4.');
    expect(result.failures[1].rule).toBe('IndentationCheck');

    fs.unlinkSync(fixturePath);
  });

  it('handles multiple files with mixed absolute and relative paths', async () => {
    const fixturePath = '/tmp/multi-file.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, readFixture('multi-file.xml'));

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.status).toBe('fail');
    expect(result.failures).toHaveLength(4);

    // ClassA error 1 - warning
    expect(result.failures[0].file).toBe('src/main/java/com/foo/ClassA.java');
    expect(result.failures[0].rule).toBe('IllegalImportCheck');

    // ClassA error 2 - error
    expect(result.failures[1].file).toBe('src/main/java/com/foo/ClassA.java');
    expect(result.failures[1].rule).toBe('ParameterNameCheck');

    // ClassB.java - relative path (second file in fixture)
    expect(result.failures[2].file).toBe('src/main/java/com/bar/ClassB.java');
    expect(result.failures[2].rule).toBe('WhitespaceAroundCheck');

    // ClassC.java - relative path
    expect(result.failures[3].file).toBe('src/main/java/com/baz/ClassC.java');
    expect(result.failures[3].rule).toBe('JavadocClassCheck');

    fs.unlinkSync(fixturePath);
  });

  it('handles empty report (no errors)', async () => {
    const fixturePath = '/tmp/empty.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, readFixture('empty.xml'));

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.status).toBe('pass');
    expect(result.summary).toBe('no lint errors');
    expect(result.failures).toHaveLength(0);

    fs.unlinkSync(fixturePath);
  });

  it('handles malformed XML gracefully', async () => {
    const fixturePath = '/tmp/malformed.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, 'not valid xml < broken');

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.status).toBe('error');
    expect(result.summary).toBe('failed to parse checkstyle XML output');
    expect(result.failures).toHaveLength(0);

    fs.unlinkSync(fixturePath);
  });

  it('handles missing optional line attribute', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="10.12.3">
  <file name="Test.java">
    <error message="Issue without line" source="com.foo.BarCheck" severity="error"/>
  </file>
</checkstyle>`;

    const fixturePath = '/tmp/no-line.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, xml);

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.status).toBe('fail');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe('Test.java');
    expect(result.failures[0].line).toBeUndefined();
    expect(result.failures[0].rule).toBe('BarCheck');

    fs.unlinkSync(fixturePath);
  });

  it('handles missing optional source attribute', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="10.12.3">
  <file name="Test.java">
    <error line="10" message="Issue without source" severity="error"/>
  </file>
</checkstyle>`;

    const fixturePath = '/tmp/no-source.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, xml);

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.status).toBe('fail');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].rule).toBeUndefined();

    fs.unlinkSync(fixturePath);
  });

  it('handles missing optional severity attribute', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="10.12.3">
  <file name="Test.java">
    <error line="10" message="Issue without severity" source="com.foo.BarCheck"/>
  </file>
</checkstyle>`;

    const fixturePath = '/tmp/no-severity.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, xml);

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.status).toBe('fail');
    expect(result.failures).toHaveLength(1);
    // Missing severity defaults to error, showing breakdown format
    expect(result.summary).toBe('1 findings (1 errors)');

    fs.unlinkSync(fixturePath);
  });

  it('filters out severity="ignore" findings', async () => {
    const fixturePath = '/tmp/mixed-severity.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, readFixture('mixed-severity.xml'));

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.failures).toHaveLength(3); // 4 errors - 1 ignored = 3
    // Verify the ignored one is not in the output
    expect(result.failures.every((f) => !f.message?.includes('Ignored'))).toBe(true);

    fs.unlinkSync(fixturePath);
  });

  it('handles mixed severities in summary', async () => {
    const fixturePath = '/tmp/mixed-severity.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, readFixture('mixed-severity.xml'));

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.status).toBe('fail');
    expect(result.summary).toBe('3 findings (1 errors, 1 warnings, 1 info)');

    fs.unlinkSync(fixturePath);
  });

  it('preserves ktlint-style source IDs (category:id format)', async () => {
    const fixturePath = '/tmp/ktlint-style.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, readFixture('ktlint-style.xml'));

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].rule).toBe('standard:semicolon'); // not mangled

    fs.unlinkSync(fixturePath);
  });

  it('does not mangle non-FQCN source names', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="10.12.3">
  <file name="Test.java">
    <error line="10" message="Issue" source="my-custom-check" severity="error"/>
  </file>
</checkstyle>`;

    const fixturePath = '/tmp/custom-source.xml';
    const fs = require('fs');
    fs.writeFileSync(fixturePath, xml);

    ctx.artifactPaths = [fixturePath];

    const result = await parser.parse(ctx);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].rule).toBe('my-custom-check');

    fs.unlinkSync(fixturePath);
  });

  it('aggregates multiple artifact paths', async () => {
    const fs = require('fs');
    const xml1 = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="10.12.3">
  <file name="File1.java">
    <error line="1" message="Error 1" source="com.foo.Check1" severity="error"/>
  </file>
</checkstyle>`;

    const xml2 = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="10.12.3">
  <file name="File2.java">
    <error line="2" message="Error 2" source="com.foo.Check2" severity="warning"/>
  </file>
</checkstyle>`;

    const fixturePath1 = '/tmp/artifact1.xml';
    const fixturePath2 = '/tmp/artifact2.xml';
    fs.writeFileSync(fixturePath1, xml1);
    fs.writeFileSync(fixturePath2, xml2);

    ctx.artifactPaths = [fixturePath1, fixturePath2];

    const result = await parser.parse(ctx);

    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].file).toBe('File1.java');
    expect(result.failures[1].file).toBe('File2.java');

    fs.unlinkSync(fixturePath1);
    fs.unlinkSync(fixturePath2);
  });

  it('falls back to stdoutPath when artifactPaths is empty', async () => {
    const fs = require('fs');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="10.12.3">
  <file name="StdoutFile.java">
    <error line="5" message="From stdout" source="com.foo.Check" severity="error"/>
  </file>
</checkstyle>`;

    const stdoutPath = '/tmp/stdout.xml';
    fs.writeFileSync(stdoutPath, xml);

    ctx.artifactPaths = [];
    ctx.stdoutPath = stdoutPath;

    const result = await parser.parse(ctx);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe('StdoutFile.java');

    fs.unlinkSync(stdoutPath);
  });
});
