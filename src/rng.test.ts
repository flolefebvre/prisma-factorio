import { expect, test } from "vitest";
import { createPicker, randomSeed, type Picker } from "./rng.js";

const SEED = 1234;
const LIST = ["a", "b", "c", "d"];
const EMPTY: readonly string[] = [];

function draw(count: number, pick: Picker, list: readonly string[]): (string | undefined)[] {
  return Array.from({ length: count }, () => pick(list));
}

test("two pickers built on one seed draw the same sequence", () => {
  expect(draw(10, createPicker(SEED), LIST)).toStrictEqual(draw(10, createPicker(SEED), LIST));
});

test("pickers built on different seeds part company", () => {
  expect(draw(10, createPicker(SEED), LIST)).not.toStrictEqual(draw(10, createPicker(SEED + 1), LIST));
});

test("a picker left to seed itself draws a sequence of its own", () => {
  expect(draw(10, createPicker(), LIST)).not.toStrictEqual(draw(10, createPicker(), LIST));
});

test("every pick comes from the list it was given", () => {
  const picks = draw(50, createPicker(SEED), LIST);

  expect(picks.filter((value) => value === undefined || !LIST.includes(value))).toStrictEqual([]);
});

test("picks spread over the whole list rather than settling on one element", () => {
  expect(new Set(draw(60, createPicker(SEED), LIST)).size).toBe(LIST.length);
});

test("a list of one always picks that one element", () => {
  expect(draw(3, createPicker(SEED), ["only"])).toStrictEqual(["only", "only", "only"]);
});

// A pool of one leaves the stream where it found it, so the picks a graph makes over a longer pool
// fall the same way whatever the pools it crossed on the way there hold.
test("a list of one draws nothing, leaving a later list picked exactly as it would have been", () => {
  const interrupted = createPicker(SEED);

  void draw(3, interrupted, ["only"]);

  expect(draw(5, interrupted, LIST)).toStrictEqual(draw(5, createPicker(SEED), LIST));
});

test("an empty list picks nothing", () => {
  expect(createPicker(SEED)(EMPTY)).toBeUndefined();
});

test("an empty list draws nothing either", () => {
  const skipped = createPicker(SEED);

  void skipped(EMPTY);

  expect(draw(5, skipped, LIST)).toStrictEqual(draw(5, createPicker(SEED), LIST));
});

test("two seeds drawn at random differ", () => {
  expect(randomSeed()).not.toBe(randomSeed());
});
