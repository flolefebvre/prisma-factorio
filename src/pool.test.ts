import { expect, test } from "vitest";
import { recycledPool, type Pool } from "./pool.js";

const ada = { id: 1, email: "ada@example.com" };
const grace = { id: 2, email: "grace@example.com" };
const draft = { id: 7, title: "draft" };

test("a row pooled for a model lands under that model", () => {
  expect(recycledPool({}, "user", ada)).toStrictEqual({ user: [ada] });
});

test("a list of rows pools every one of them, in order", () => {
  expect(recycledPool({}, "user", [ada, grace])).toStrictEqual({ user: [ada, grace] });
});

test("successive calls merge a model's rows rather than replacing them", () => {
  expect(recycledPool(recycledPool({}, "user", ada), "user", grace)).toStrictEqual({ user: [ada, grace] });
});

test("different models keep lists of their own", () => {
  expect(recycledPool(recycledPool({}, "user", ada), "post", draft)).toStrictEqual({ user: [ada], post: [draft] });
});

test("pooling no rows leaves the rows the model already carries standing", () => {
  expect(recycledPool(recycledPool({}, "user", ada), "user", [])).toStrictEqual({ user: [ada] });
});

// A model whose list is empty is a model that was never pooled, so the key stays absent rather than
// standing for a pool nothing can be drawn from.
test("pooling no rows for a model carrying none pools nothing at all", () => {
  expect(recycledPool({}, "user", [])).toStrictEqual({});
});

test("pooling leaves the pool it was handed untouched", () => {
  const baseline: Pool = recycledPool({}, "user", ada);

  void recycledPool(baseline, "user", grace);

  expect(baseline).toStrictEqual({ user: [ada] });
});
