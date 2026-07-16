import type { DMMF, GeneratorConfig } from "@prisma/generator-helper";

/**
 * Builds a DMMF model for tests, defaulting every structural property so a
 * test only states what it cares about.
 *
 * @example
 * const user = modelFixture({ name: "User" });
 */
export function modelFixture(overrides: Partial<DMMF.Model> & Pick<DMMF.Model, "name">): DMMF.Model {
  return {
    dbName: null,
    schema: null,
    fields: [],
    uniqueFields: [],
    uniqueIndexes: [],
    primaryKey: null,
    ...overrides,
  };
}

/**
 * Builds a DMMF field for tests, defaulting to a required scalar so a test only
 * states what it cares about. Pass `kind: "object"` with a `type` naming the
 * related model to build a relation field.
 *
 * @example
 * const author = fieldFixture({ name: "author", kind: "object", type: "User" });
 */
export function fieldFixture(overrides: Partial<DMMF.Field> & Pick<DMMF.Field, "name">): DMMF.Field {
  return {
    kind: "scalar",
    type: "String",
    isRequired: true,
    isList: false,
    isUnique: false,
    isId: false,
    isReadOnly: false,
    hasDefaultValue: false,
    ...overrides,
  };
}

/**
 * Builds a DMMF datamodel for tests from the given models.
 *
 * @example
 * const datamodel = datamodelFixture([modelFixture({ name: "User" })]);
 */
export function datamodelFixture(models: DMMF.Model[]): DMMF.Datamodel {
  return { models, enums: [], types: [], indexes: [] };
}

/**
 * Builds a GeneratorConfig for tests, defaulting every structural property so
 * a test only states the provider and output it cares about.
 *
 * @example
 * const client = generatorConfigFixture({ provider: "prisma-client", output: "/app/generated/client" });
 */
export function generatorConfigFixture(overrides: { provider: string; output?: string | null }): GeneratorConfig {
  return {
    name: overrides.provider,
    provider: { fromEnvVar: null, value: overrides.provider },
    output:
      overrides.output === undefined || overrides.output === null
        ? null
        : { fromEnvVar: null, value: overrides.output },
    config: {},
    binaryTargets: [],
    previewFeatures: [],
    sourceFilePath: "/app/prisma/schema.prisma",
  };
}
