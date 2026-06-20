# Documentation Guidelines

## Placement

| Tier | Purpose | Consumer |
|------|---------|----------|
| **Code** (`src/`) | Implementation details, type definitions, inline comments | Agents reading code |
| **Docs** (`docs/`) | Architecture, user guides, troubleshooting | Humans + agents needing context beyond code |
| **Steering** (`.kiro/steering/`) | Cross-cutting rules, conventions, principles | Agents on every interaction |
| **Specs** (`.kiro/specs/`) | Feature designs, requirements, task lists | Agents during feature work |

### Decision Framework

1. **Readable from code?** → Don't document it
2. **Convention or principle?** → Steering file
3. **Feature design?** → Spec
4. **Architecture, user-facing, or troubleshooting?** → Docs
5. **One-time artifact?** → Don't write it (git history is enough)
6. **Restatement of library docs?** → Link to official source, document only our delta

## File Structure

```
docs/
├── README.md              # Index (table format)
├── getting-started.md     # Setup, install, first run
├── user-guide.md          # End-user guide
├── developer-guide.md     # Architecture, patterns, deployment
├── changelog.md           # Last 2 weeks only
├── api-services.md        # Service layer reference
├── route-shapes.md        # Shape caching, distance calcs
└── troubleshooting/       # Split by category
    └── README.md          # Table index
```

## Routing Rules

| Content type | Destination |
|-------------|-------------|
| Setup/install | `getting-started.md` |
| User features | `user-guide.md` + `changelog.md` |
| Architecture/patterns | `developer-guide.md` |
| API details | `api-services.md` |
| Route shapes | `route-shapes.md` |
| Bug fixes | appropriate `troubleshooting/` file |
| Conventions/principles | `.kiro/steering/` |
| Feature designs | `.kiro/specs/` |
| Issues/backlog | GitHub Issues |

## Content Rules

- Never create markdown files in project root (except README.md)
- Update existing files, don't create new ones
- Keep files under 300 lines
- Prefer tables over prose for reference data
- Prefer code paths over code examples (e.g., "see `src/utils/core/constants.ts`")
- Keep docs scannable: short sections, clear headers, no emoji
- Every `docs/` subdirectory must have a README.md index as a table
- Use Mermaid for diagrams (no ASCII art, no image files)

## What NOT to Document

- Implementation details readable from code
- Performance benchmarks without CI integration
- Feature backlogs (use GitHub Issues)
- Content already in steering or specs
- Tutorials for public libraries (link to official docs)
- Temporal artifacts (use `temporary/` folder, git-ignored)

## Changelog

- Keep last 2 weeks only
- Format: `**TYPE**: Description`
- Archive by deleting

## Troubleshooting Entries

- Format: `**Problem**: Brief` / `**Solution**: One-line fix`
- Max 3 lines per issue
- Delete resolved issues after 1 month
