import type { DMMF } from "@prisma/generator-helper";

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
 * Builds a DMMF datamodel for tests from the given models.
 *
 * @example
 * const datamodel = datamodelFixture([modelFixture({ name: "User" })]);
 */
export function datamodelFixture(models: DMMF.Model[]): DMMF.Datamodel {
  return { models, enums: [], types: [], indexes: [] };
}
