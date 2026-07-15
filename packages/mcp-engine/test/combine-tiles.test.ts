import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineTiles, type CombinableResult } from '../src/index';

/** A minimal but structurally faithful tile result: two dimension columns over
    a couple of rows, plus a result-level render tag and internal metadata. */
function tileResult(cols: string[], rows: number[][], annotations: string[]): CombinableResult {
  return {
    connection_name: 'duckdb',
    model_annotations: [{ value: '##! experimental { givens }\n' }],
    annotations: annotations.map((value) => ({ value })),
    schema: { fields: cols.map((name) => ({ kind: 'dimension', name, type: { kind: 'number_type' } })) },
    data: {
      kind: 'array_cell',
      array_value: rows.map((r) => ({
        kind: 'record_cell',
        record_value: r.map((n) => ({ kind: 'number_cell', number_value: n })),
      })),
    },
  };
}

test('combineTiles: each tile becomes an array<record> nest field with its data verbatim', () => {
  const t1 = tileResult(['decade', 'total'], [[1910, 5], [1920, 7]], [
    '#(malloy) query_name = births_by_decade\n',
  ]);
  const t2 = tileResult(['year', 'total'], [[2000, 3]], [
    '# line_chart\n',
    '#(malloy) query_name = births_by_year\n',
  ]);

  const combined = combineTiles(
    [
      { name: 'by_decade', result: t1 },
      { name: 'by_year', result: t2 },
    ],
    { columns: 3 },
  );

  // Root is a # dashboard with the columns pass-through.
  assert.deepEqual(combined.annotations, [{ value: '# dashboard {columns=3}\n' }]);
  assert.equal(combined.model_annotations?.[0].value, '##! experimental { givens }\n');

  // Two nest fields, each an array<record> of the tile's columns.
  assert.equal(combined.schema.fields.length, 2);
  const f0 = combined.schema.fields[0];
  assert.equal(f0.kind, 'dimension');
  assert.equal(f0.name, 'by_decade');
  const ty = f0.type as { kind: string; element_type: { kind: string; fields: { name: string }[] } };
  assert.equal(ty.kind, 'array_type');
  assert.equal(ty.element_type.kind, 'record_type');
  assert.deepEqual(ty.element_type.fields.map((f) => f.name), ['decade', 'total']);

  // Render tags are lifted onto the card; internal #(malloy) metadata is not.
  assert.deepEqual(combined.schema.fields[1].annotations, [{ value: '# line_chart\n' }]);
  assert.deepEqual(combined.schema.fields[0].annotations, []);

  // One dashboard row; each column cell IS the tile's own data (verbatim).
  assert.equal(combined.data?.kind, 'array_cell');
  assert.equal(combined.data?.array_value?.length, 1);
  const row = combined.data!.array_value![0];
  assert.equal(row.kind, 'record_cell');
  assert.equal(row.record_value?.length, 2);
  assert.strictEqual(row.record_value![0], t1.data); // same object, not a copy
  assert.strictEqual(row.record_value![1], t2.data);
});

test('combineTiles: omits columns when unset, and dedupes colliding tile names', () => {
  const t = tileResult(['a'], [[1]], []);
  const combined = combineTiles([
    { name: 'by_month', result: t },
    { name: 'by_month', result: t },
  ]);
  assert.deepEqual(combined.annotations, [{ value: '# dashboard\n' }]); // no {columns=…}
  assert.deepEqual(combined.schema.fields.map((f) => f.name), ['by_month', 'by_month_2']);
});
