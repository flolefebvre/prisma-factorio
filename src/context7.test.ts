import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Context7's limits, from its schema at https://context7.com/schema/context7.json. Context7 enforces
// them when it reads the file, so an entry over a limit costs consumers' agents the guidance it carries.
const MAX_RULE_LENGTH = 255;
const MAX_RULES = 50;
const MAX_DESCRIPTION_LENGTH = 200;

const config = JSON.parse(readFileSync(new URL("../context7.json", import.meta.url), "utf8")) as {
  description: string;
  rules: string[];
};

test.each(config.rules.map((rule, index) => ({ index, rule })))(
  "rule $index fits Context7's per-rule limit",
  ({ rule }) => {
    expect(rule.length).toBeLessThanOrEqual(MAX_RULE_LENGTH);
  },
);

test("the rule count fits Context7's limit", () => {
  expect(config.rules.length).toBeLessThanOrEqual(MAX_RULES);
});

test("the description fits Context7's limit", () => {
  expect(config.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
});
