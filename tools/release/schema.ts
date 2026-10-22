/** One source for runtime shape checks and the published draft-2020-12 schema. */
type Shape = { type?: string | string[]; const?: unknown; enum?: readonly unknown[]; properties?: Record<string, Shape>; required?: string[]; additionalProperties?: boolean; items?: Shape; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number; anyOf?: Shape[]; $ref?: string };
const text: Shape = { type: 'string', minLength: 1, maxLength: 4096 };
const id: Shape = { ...text, maxLength: 256, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/ -]*$' };
const hash: Shape = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const integer: Shape = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullable = (shape: Shape): Shape => ({ anyOf: [shape, { type: 'null' }] });
const array = (items: Shape, maximum = 50_000): Shape => ({ type: 'array', items, maxItems: maximum });
const object = (properties: Record<string, Shape>): Shape => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const ref = (name: string): Shape => ({ $ref: '#/$defs/' + name });
const kinds = ['vitest', 'playwright', 'native', 'format', 'visual', 'manual', 'https', 'benchmark'];
const review = object({ identity: text, atUtc: text, reason: text });
const definition: Record<string, Shape> = {};
definition.FileRef = object({ path: text, bytes: integer, sha256: hash });
definition.RequiredCell = object({ id, kind: { enum: kinds }, scope: text, configurationIds: array(id, 1000), requiredCaseIds: array(text) });
definition.Capability = object({ id, desktopFeature: text, scope: { enum: ['retained', 'excluded'] }, implementation: { enum: ['implemented', 'partial', 'planned', 'excluded'] }, requiredCells: array(ref('RequiredCell'), 1000), approvedDifferenceIds: array(id, 1000), exclusionReason: nullable(text) });
definition.CapabilityLedger = object({ schemaVersion: { const: 1 }, kind: { const: 'splatview-capability-ledger' }, desktopContract: object({ revision: text, capture: ref('FileRef') }), sourceFeatureLedger: ref('FileRef'), capabilityInventory: ref('FileRef'), capabilities: array(ref('Capability'), 1000), gates: array(ref('RequiredCell'), 1000), differences: array(object({ id, description: text, reason: text }), 1000) });
definition.SourceCapture = object({ schemaVersion: { const: 1 }, kind: { const: 'splatview-release-source-capture' }, appInputId: hash, deploymentId: hash, applicationInputs: array(ref('FileRef')), nativeFiles: array(ref('FileRef'), 5), distribution: array(ref('FileRef')), coveredInputs: array(ref('FileRef')) });
definition.Shipping = object({ sourceCapture: ref('FileRef'), applicationInputs: array(ref('FileRef')), nativeFiles: array(ref('FileRef'), 5), distribution: array(ref('FileRef')), manifest: ref('FileRef') });
definition.ReportExpectation = object({ id, adapter: { enum: ['vitest', 'playwright'] }, command: object({ executable: ref('FileRef'), arguments: array({ type: 'string', maxLength: 4096 }, 1000), workingDirectory: { const: '.' } }), report: ref('FileRef'), coveredInputs: array(ref('FileRef')), files: array(object({ path: text, leaves: array(object({ id: text, title: text, project: { type: 'string', maxLength: 4096 } })) })), outputDirectory: nullable(text), outputFiles: array(ref('FileRef')), requiredAttachments: array(object({ caseId: text, project: { type: 'string', maxLength: 4096 }, name: text, sha256: nullable(hash), fixtureSetId: nullable(hash) })) });
definition.ExpectedInventory = object({ schemaVersion: { const: 1 }, kind: { const: 'splatview-release-expected-inventory' }, suites: array(ref('ReportExpectation'), 1000) });
definition.Applicability = object({ kind: { enum: ['exact', 'unchanged-covered-inputs'] }, observedAppInputId: hash, observedDeploymentId: hash, observedSourceCapture: ref('FileRef'), coveredInputs: array(ref('FileRef')), review: nullable(review) });
definition.TestEvidence = object({ id, kind: { enum: ['vitest', 'playwright'] }, terminal: ref('FileRef'), expectationId: id, applicability: ref('Applicability'), fixtureSet: nullable(ref('FileRef')) });
definition.TestEvidence.properties!.fixtureApplicability = nullable(ref('FileRef'));
const summary = object({ bytes: integer, sha256: hash });
const fixtureTool = object({ recordedPath: text, artifact: ref('FileRef') });
definition.FixtureApplicability = object({ schemaVersion: { const: 1 }, kind: { const: 'splatview-offline-fixture-applicability' }, fixtureSet: ref('FileRef'), observedSourceCapture: ref('FileRef'), currentSourceInventory: ref('FileRef'), coveredInputs: array(ref('FileRef')), differences: array(object({ path: text, before: nullable(summary), after: nullable(summary), reason: text })), tools: object({ node: fixtureTool, npm: fixtureTool, python: fixtureTool }), hostOrigin: text, review });
definition.BenchmarkEvidence = object({ id, kind: { const: 'benchmark' }, terminal: ref('FileRef'), report: ref('FileRef'), target: ref('FileRef'), expectedBuild: ref('FileRef'), applicability: ref('Applicability') });
definition.PendingEvidence = object({ id, kind: { const: 'pending' }, pendingKind: { enum: kinds }, reason: text });
definition.Evidence = { anyOf: [ref('TestEvidence'), ref('BenchmarkEvidence'), ref('PendingEvidence')] };
definition.Claims = object({ configurations: array(id, 1000), budgets: array(object({ id, benchmarkEvidenceId: id, cellId: id, maximumSceneRecords: { ...integer, minimum: 1 } }), 1000) });
definition.ReleaseRequest = object({ schemaVersion: { const: 1 }, kind: { const: 'splatview-release-request' }, id, mode: { enum: ['bounded', 'full-editor'] }, ledger: ref('FileRef'), shipping: ref('Shipping'), expectedInventory: ref('FileRef'), evidence: array(ref('Evidence'), 1000), requestedCells: array(id, 10_000), bindings: array(object({ cellId: id, evidenceId: id, caseIds: array(text) }), 10_000), claims: ref('Claims'), review });
definition.EvidenceResult = object({ id, kind: { enum: ['vitest', 'playwright', 'benchmark', 'pending'] }, valid: { type: 'boolean' }, qualified: { type: 'boolean' }, issues: array(text), pending: array(text), caseIds: array(text), configurationIds: array(id), references: array(ref('FileRef')), leaves: array(object({ id: text, file: text, title: text, project: { type: 'string', maxLength: 4096 }, passed: { type: 'boolean' }, attachments: array(object({ name: text, contentType: text, bytes: integer, sha256: hash, path: nullable(text) })) })) });
definition.ReleaseBundle = object({ schemaVersion: { const: 1 }, kind: { const: 'splatview-release-evidence' }, request: ref('FileRef'), id, observedAtUtc: text, valid: { type: 'boolean' }, boundedAccepted: { type: 'boolean' }, fullEditorAccepted: { type: 'boolean' }, status: { enum: ['invalid', 'pending', 'accepted'] }, shipping: nullable(object({ appInputId: hash, deploymentId: hash, manifest: ref('FileRef'), sourceCapture: ref('FileRef'), distribution: array(ref('FileRef')) })), ledger: ref('FileRef'), expectedInventory: ref('FileRef'), evidence: array(ref('EvidenceResult')), cells: array(object({ id, kind: { enum: kinds }, status: { enum: ['qualified', 'pending'] }, evidenceId: nullable(id), reason: text })), acceptedCells: array(id), pendingCells: array(id), issues: array(text), pending: array(text), claims: ref('Claims'), review, limitations: array(text) });

export const releaseSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://splatview.github.io/docs/validation/release-evidence.schema.json', title: 'SplatView release evidence and referenced request contracts', ...ref('ReleaseBundle'), $defs: definition };
export type ContractName = 'ReleaseRequest' | 'CapabilityLedger' | 'SourceCapture' | 'ExpectedInventory' | 'ReleaseBundle' | 'FixtureApplicability';
export function shapeIssues(name: ContractName, value: unknown): string[] {
  const issues: string[] = [];
  const check = (shape: Shape, item: unknown, at: string, depth: number, output: string[]): void => {
    if (depth > 64 || output.length >= 200) { output.push(`${at}: structure bound exceeded`); return; }
    if (shape.$ref) { check(definition[shape.$ref.split('/').at(-1)!]!, item, at, depth + 1, output); return; }
    if (shape.anyOf) { if (!shape.anyOf.some(option => { const attempt: string[] = []; check(option, item, at, depth + 1, attempt); return !attempt.length; })) output.push(`${at}: no allowed contract shape`); return; }
    if ('const' in shape && item !== shape.const) output.push(`${at}: wrong constant`);
    if (shape.enum && !shape.enum.includes(item)) output.push(`${at}: value outside enum`);
    if (shape.type) {
      const actual = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item;
      if (shape.type === 'integer' ? typeof item !== 'number' || !Number.isSafeInteger(item) : actual !== shape.type) { output.push(`${at}: expected ${String(shape.type)}`); return; }
    }
    if (typeof item === 'number' && (!Number.isFinite(item) || (shape.minimum !== undefined && item < shape.minimum) || (shape.maximum !== undefined && item > shape.maximum))) output.push(`${at}: numeric bound`);
    if (typeof item === 'string' && ((shape.minLength !== undefined && item.length < shape.minLength) || (shape.maxLength !== undefined && item.length > shape.maxLength) || (shape.pattern && !new RegExp(shape.pattern, 'u').test(item)))) output.push(`${at}: string bound/pattern`);
    if (Array.isArray(item)) { if ((shape.maxItems !== undefined && item.length > shape.maxItems) || (shape.minItems !== undefined && item.length < shape.minItems)) output.push(`${at}: array bound`); if (shape.items) item.forEach((child, index) => check(shape.items!, child, `${at}[${index}]`, depth + 1, output)); }
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && shape.properties) {
      const row = item as Record<string, unknown>;
      for (const key of shape.required ?? []) if (!Object.hasOwn(row, key)) output.push(`${at}.${key}: missing`);
      for (const [key, child] of Object.entries(row)) { if (!shape.properties[key]) { if (shape.additionalProperties === false) output.push(`${at}.${key}: unknown field`); } else check(shape.properties[key]!, child, `${at}.${key}`, depth + 1, output); }
    }
  };
  check(definition[name]!, value, name, 0, issues); return issues;
}
export function assertShape<T>(name: ContractName, value: unknown): asserts value is T { const issues = shapeIssues(name, value); if (issues.length) throw new Error(issues.join('; ')); }
