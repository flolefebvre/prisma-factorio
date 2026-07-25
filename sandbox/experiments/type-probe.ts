/** Scratch file: checks which schema-derived types resolve as intended. */
import type { PrismaClient, Prisma } from "../generated/client.ts";

type IsAny<T> = 0 extends 1 & T ? true : false;

type UserArgs = Prisma.Args<PrismaClient["user"], "create">;
type UserData = UserArgs extends { data: infer D } ? D : never;

const probe1: IsAny<UserArgs> = false;
const probe2: IsAny<UserData> = false;
type UserResult = Prisma.Result<PrismaClient["user"], object, "create">;
const probe3: IsAny<UserResult> = false;
type UserResultInc = Prisma.Result<PrismaClient["user"], { include: { posts: true } }, "create">;
const probe4: IsAny<UserResultInc> = false;

// What does the resolved data type actually contain?
declare const d: UserData;
declare const r: UserResult;
declare const ri: UserResultInc;
export const checks = [probe1, probe2, probe3, probe4, d, r, ri];
