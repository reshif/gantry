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
  assert.deepEqual(run({ "0003_c.sql": "-- gantry:contract after abc1234\nalter table a drop column b;" }), []);
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
  assert.match(run({ "0003_c.sql": "-- gantry:contract after abc1234\ncreate table n (id int);\nalter table a drop column b;" }).join(), /must not also create/);
  assert.match(run({ "0003_c.sql": "-- gantry:contract after abc1234\nselect 1;" }).join(), /removes nothing/);
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
  assert.deepEqual(info({ ...base, "0003_c.sql": "-- gantry:contract after abc1234\ndrop table a;", "0004_d.sql": "create table q (i int);" }), { latest: 4, lastContract: 3, files: 4, contracts: [{ n: 3, after: "abc1234" }] });
  assert.deepEqual(info(base), { latest: 2, lastContract: 0, files: 2, contracts: [] });
});

test("a contract mark must name the commit that stopped using what it removes", () => {
  assert.match(run({ "0003_c.sql": "-- gantry:contract nothing reads b\nalter table a drop column b;" }).join(), /must name the commit/);
});
test("a DO block runs now, so a drop inside it is a contract; a function body does not", () => {
  assert.ok(classify("do $$ begin drop table t; end $$;").destructive);
  assert.ok(classify("do $body$ begin alter table a drop column b; end $body$;").destructive);
  assert.ok(!classify("create or replace function f() returns void as $$ begin drop table t; end $$ language plpgsql;").destructive);
  assert.deepEqual(run({ "0003_c.sql": "-- gantry:contract after abc1234\ndo $$ begin drop table a; end $$;" }), []);
});
test("tightening is a contract: NOT NULL without default, CHECK, UNIQUE, FOREIGN KEY", () => {
  for (const sql of ["alter table a add column x text not null;", "alter table a add constraint c check (b > 0);", "alter table a add constraint u unique (b);",
    "alter table a add constraint f foreign key (b) references z(id);", "create unique index on a (b);", "alter table a add column x int references z(id);"])
    assert.ok(classify(sql).destructive, sql);
});
test("what does not tighten stays an expand", () => {
  for (const sql of ["alter table a add column x text not null default '';", "alter table a add column x text;", "create index on a (b);",
    "create table n (id int primary key, b int not null unique);\ncreate unique index on n (b);", "alter table a add constraint c check (b > 0) not valid;"])
    assert.ok(!classify(sql).destructive, sql);
});
