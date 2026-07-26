# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on `flolefebvre/prisma-factorio`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Dependencies between issues

Ordering between issues is encoded with GitHub's native "blocked by" relationships.

Creating one goes through the REST API and takes the blocker's database id, not its number:

```bash
gh api -X POST repos/flolefebvre/prisma-factorio/issues/<blocked>/dependencies/blocked_by \
  -F issue_id="$(gh api repos/flolefebvre/prisma-factorio/issues/<blocker> --jq .id)"
```

`gh issue list --json` does not expose the relationships — query them via GraphQL:

```bash
gh api graphql -f query='
query {
  repository(owner: "flolefebvre", name: "prisma-factorio") {
    issues(first: 100, states: OPEN, labels: ["ready-for-agent"]) {
      nodes {
        number
        title
        blockedBy(first: 20) { nodes { number state } }
      }
    }
  }
}' --jq '.data.repository.issues.nodes | map(select(all(.blockedBy.nodes[]?; .state == "CLOSED"))) | .[] | "\(.number)\t\(.title)"'
```

The `--jq` filter keeps only actionable issues — those whose blockers are all closed. Drop it to see the full graph. An issue unblocks its dependents only when it is closed, so a PR that finishes an issue must close it: `Closes #<number>` in the PR body, or close the issue explicitly after merging.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
