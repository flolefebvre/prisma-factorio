import type { Args, Payload, Result } from "@prisma/client/runtime/client";

/** Structural shape shared by every generated Prisma model delegate. */
export interface AnyDelegate {
  findFirst: (...args: never[]) => unknown;
}

/** The delegate property names of a Prisma client (`"user" | "post" | …`). */
export type ModelName<C> = {
  [K in keyof C]: K extends string ? (C[K] extends AnyDelegate ? K : never) : never;
}[keyof C];

/** `Prisma.XCreateArgs["data"]`, reachable without naming the model type. */
export type CreateData<C, M extends ModelName<C>> = Args<C[M], "create"> extends { data: infer D } ? D : never;

export type ModelObjects<C, M extends ModelName<C>> = Payload<C[M]>["objects"];
export type ModelScalars<C, M extends ModelName<C>> = Payload<C[M]>["scalars"];
export type ModelPayloadName<C, M extends ModelName<C>> = Payload<C[M]>["name"];

export type Unwrap<T> = T extends readonly (infer E)[] ? E : NonNullable<T>;

/** Maps a payload name (`"User"`) back to its delegate name (`"user"`). */
export type ModelByPayloadName<C, N> = {
  [M in ModelName<C>]: ModelPayloadName<C, M> extends N ? M : never;
}[ModelName<C>];

/** The model a relation field points at, whatever its cardinality. */
export type RelatedModel<C, M extends ModelName<C>, K extends keyof ModelObjects<C, M>> = ModelByPayloadName<
  C,
  Unwrap<ModelObjects<C, M>[K]>["name"]
>;

export type ListRelation<C, M extends ModelName<C>> = {
  [K in keyof ModelObjects<C, M>]: ModelObjects<C, M>[K] extends readonly unknown[] ? K : never;
}[keyof ModelObjects<C, M>] &
  string;

export type ToOneRelation<C, M extends ModelName<C>> = Exclude<keyof ModelObjects<C, M>, ListRelation<C, M>> & string;

/** The record type `create` returns for a given include selection. */
export type CreateResult<C, M extends ModelName<C>, Inc> = Result<C[M], { include: Inc }, "create">;

export type Cardinality = "one" | "many";

export type Produced<C, M extends ModelName<C>, Inc, Card extends Cardinality> = Card extends "many"
  ? CreateResult<C, M, Inc>[]
  : CreateResult<C, M, Inc>;
