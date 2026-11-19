import { test } from "node:test";
import assert from "node:assert/strict";
import { check, classify, info } from "./migration-safety.mjs";

const base = { "0001_a.sql": "create table a (id int);", "0002_b.sql": "alter table a add column b int;" };
const run = (extra, b = base) => check(b, { ...b, ...extra }).problems;

test("an additive migration passes", () => {
  assert.deepEqual(run({ "0003_c.sql": "alter table a add column c text not null default '';\ncreate index on a (c);" }), []);
});
test("a drop without the contract mark fails, with the mark and alone it passes", () => {
  assert.match(run({ "0003_c.sql": "alter table a drop column b;" })[0], /contract migration/);
  assert.deepEqual(run({ "0003_c.sql": "-- gantry:contract nothing reads b since 1.4.0\nalter table a drop column b;" }), []);
});
test("rename, type change, set not null, truncate and delete are contracts", () => {
  for (const sql of ["alter table a rename column b to c;", "alter table a rename to z;", "alter table a alter column b type bigint;", "alter table a alter column b set not null;", "truncate a;", "delete from a;", "drop table a;"])
    assert.ok(classify(sql).destructive, sql);
});
test("words in comments and strings are not statements, a trigger that forbids truncate is not a truncate", () => {
  assert.ok(!classify("-- drop table a\ncreate table z (n text default 'drop table x');").destructive);
  assert.ok(!classify("create trigger t before truncate on events for each statement execute function f();").destructive);
  assert.ok(!classify("create function f() returns void as $$ begin delete from x; end $$ language plpgsql;").destructive);
});
test("a contract migration must not also add things; a mark without a removal is refused", () => {
  assert.match(run({ "0003_c.sql": "-- gantry:contract x\ncreate table n (id int);\nalter table a drop column b;" }).join(), /must not also create/);
  assert.match(run({ "0003_c.sql": "-- gantry:contract x\nselect 1;" }).join(), /removes nothing/);
});
test("an applied migration is never edited or removed", () => {
  assert.match(check(base, { "0001_a.sql": "create table a (id bigint);", "0002_b.sql": base["0002_b.sql"] }).problems.join(), /edited/);
  assert.match(check(base, { "0001_a.sql": base["0001_a.sql"] }).problems.join(), /removed/);
});
test("names: pattern, duplicate numbers and gaps", () => {
  assert.match(run({ "3_c.sql": "select 1;" }).join(), /NNNN_snake_case/);
  assert.match(run({ "0002_dup.sql": "select 1;" }).join(), /duplicate/);
  assert.match(run({ "0004_gap.sql": "select 1;" }).join(), /gap/);
});
test("info: the highest contract level is read from the marks", () => {
  assert.deepEqual(info({ ...base, "0003_c.sql": "-- gantry:contract x\ndrop table a;", "0004_d.sql": "create table q (i int);" }), { latest: 4, lastContract: 3, files: 4 });
  assert.deepEqual(info(base), { latest: 2, lastContract: 0, files: 2 });
});
