import { expect, test } from "vitest";
import { createUidSource, nextUid, randomUidPrefix, type UidSource } from "./uid.js";

const PREFIX = "aaaaaa";

function take(count: number, source: UidSource): string[] {
  return Array.from({ length: count }, () => source());
}

function expectAllDistinct(uids: string[]): void {
  expect(new Set(uids).size).toBe(uids.length);
}

test("successive calls on one source return distinct uids", () => {
  expectAllDistinct(take(3, createUidSource(PREFIX)));
});

test("every uid embeds the prefix of the source that issued it", () => {
  const uids = take(3, createUidSource("zz99zz"));

  expect(uids.every((uid) => uid.startsWith("zz99zz"))).toBe(true);
});

test("the counter behind a source only ever climbs", () => {
  const counters = take(40, createUidSource(PREFIX)).map((uid) => Number.parseInt(uid.slice(PREFIX.length), 36));

  expect(counters).toStrictEqual([...counters].sort((left, right) => left - right));
  expectAllDistinct(counters.map(String));
});

test("sources with different prefixes share no uid, counter position for counter position", () => {
  expectAllDistinct([...take(5, createUidSource(PREFIX)), ...take(5, createUidSource("bbbbbb"))]);
});

test("two sources left to pick their own prefix pick different ones", () => {
  expect(randomUidPrefix()).not.toBe(randomUidPrefix());
  expectAllDistinct([...take(2, createUidSource()), ...take(2, createUidSource())]);
});

test("the process-wide source issues distinct uids", () => {
  expectAllDistinct(take(3, nextUid));
});
