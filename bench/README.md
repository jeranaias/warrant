# bench

Attack corpus + runner + scoring.

- `schema/attack.schema.json`: format of one case. One JSON file per case in `corpus/`.
- `runner/`: loads, validates and runs every case under each config (TODO).
- `SCORING.md`: how results are counted. Read it before adding cases.
- `results/`: generated output, gitignored.

Run: `pnpm bench`
