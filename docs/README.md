# Neary docs

Source of truth for how this project is structured, named, and decided.
Code is the source of truth for behavior — these docs only capture what
isn't obvious from reading [src/](../src/).

## Layout

| Path | Contains |
|---|---|
| [architecture/](architecture/) | What the system IS now — stack, components, data pipeline |
| [concepts/](concepts/) | Vocabulary — vehicle, buckets, confidence, feeds, prediction |
| [standards/](standards/) | MUST / MUST NOT rules — short, enforceable |
| [specs/](specs/) | Contracts where the reasoning isn't in the code |
| [plan/](plan/) | Roadmap and in-flight design — short-lived |
| [investigation/](investigation/) | Historical analyses and the frozen v1 docs |

## Conventions

- Every directory has a `README.md` that links its contents.
- Files use lowercase kebab-case; `README.md` is the only uppercase file.
- Cross-references use relative paths to the smallest useful target.
- Anything that becomes obvious from code or grows stale is deleted, not preserved.
- See [standards/documentation.md](standards/documentation.md) for the placement rules.

## For AI agents

Start at [AGENTS.md](../AGENTS.md) for the canonical agent guide, then:

1. [architecture/system-overview.md](architecture/system-overview.md) — what does the system do.
2. [concepts/](concepts/) — what does this term mean.
3. [standards/](standards/) — what is the rule.
4. [plan/](plan/) — what are we building next.
5. The actual code — specs only exist where reasoning isn't there.
