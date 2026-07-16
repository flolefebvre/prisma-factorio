# Magic relationship methods: hasX / forX

For every relation field in the schema the generator emits a typed method on that model's factory base — `hasX` for a to-many relation, `forX` for a to-one — named after the relation field (`posts` → `hasPosts`, `author` → `forAuthor`). These are the only relationship API: there is no generic `has()` / `for()`. Two relations to the same model (`author`, `reviewer`) yield two distinct methods, since the schema field is the single source of names. Everything the chain declares joins one atomic `prisma.<model>.create`; existing rows connect, factories create.

## Decisions

- **Typed returns via a fourth `TResult` generic.** Each base is `XFactoryBase<TResult = XModel>`; every `hasX` / `forX` returns the base widened by the built relation (`UserFactoryBase<TResult & { posts: PostModel[] }>`), and `create()` resolves `TResult`. Composition is recursive: a child factory's own chain flows into the parent's return (`hasPosts(PostFactory.new().forAuthor(u))` → `{ posts: (Post & { author: User })[] }`). Only explicitly-chained relations widen the return; relations born inside a `definition()` stay out of the type. At runtime `create()` builds the matching `include` so the persisted row carries exactly what the type promises.

- **Default child factory: an explicit registry.** The short forms (`hasPosts(3)`, `forAuthor({ … })`) need the target model's concrete factory, which the generated base cannot name. A to-many relation is not present in the parent's definition, so — unlike `forX(overrides)`, which resolves the definition's own factory-as-value for that relation — there is no factory-as-value to reuse. `registerFactories({ Post: PostFactory, … })` (typed to the schema in the generated barrel) fills that gap, keyed by model name; a missing entry throws `FactoryNotRegisteredError` naming the model and both remedies. The rich form (`hasPosts(PostFactory.new().count(3))`) never needs the registry.

- **Back-reference short-circuit.** A child born through `hasX` has its own definition factory-as-value for the parent relation dropped before it resolves — the nesting already links them, so keeping it would create a second parent (and would cycle, since the parent is already in the resolution lineage). The generator bakes the child's inverse field name (from the shared relation name) into the method.

- **Child state closures receive `(attributes, parent)`.** The second argument is the parent's _evaluated `CreateInput`_, not a persisted row: atomic nested creates mean no parent id exists at build time. This diverges from Laravel, which passes the saved parent model; code needing the parent's id uses `afterCreating` (a later slice). `state()` is generic over the parent type so a child closure can annotate it (`(attrs, parent: UserCreateInput) => …`).

- **Chaining order.** A magic method returns the base type carrying the accumulated `TResult`, not the concrete user subclass, so user-defined named states must come before magic methods in a chain (`UserFactory.new().admin().hasPosts(3)`, not the reverse). This mirrors the existing "named states before `.count()`" constraint of `ListFactory`.

- **`forX(existing-row)` vs `forX(overrides)` distinguished by the id field.** An argument object carrying the target model's id field (with a defined value) is treated as an existing row to connect; otherwise it is applied as overrides on the default factory. A consequence: passing overrides that happen to set the id resolves to a connect, not a create — set the id through the built factory instead.

- **Self-relations nest their own class.** A magic-method child is a finite, caller-written node, so it starts a fresh resolution lineage: `hasChildren` / `forParent` on a tree model legitimately build the same class, while the child's own definition factory-as-values are still cycle-checked against that fresh lineage. Only definition-driven factory-as-value resolution (which auto-expands) accumulates the ancestor lineage that raises `FactoryCycleError`.

- **Explicit join models get no dedicated API.** A join model (pivot columns, two required belongsTo) is an ordinary model with its own factory; its belongsTo relations are factory-as-values and its `forX` methods attach existing rows. There is no `hasAttached` or join-model heuristic.

## Consequences

`registerFactories` is a small amount of required startup wiring for the short forms — accepted because it is the only registration-free-at-emit way to reach a to-many's factory, and the error when it is missing is explicit. The chaining-order and `(attributes, parent)` constraints are documented divergences a user must learn once.
