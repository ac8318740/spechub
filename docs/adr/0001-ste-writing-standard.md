# One plain-language writing standard based on ASD-STE100

Every durable artifact an agent writes follows one standard. The standard lives in the `writing` skill and follows ASD-STE100 – Simplified Technical English, an aerospace standard for controlled technical writing. We adopt its rules: short sentences with a numeric cap, active voice, one instruction per sentence, one term for one meaning. We reject the "add voice" advice common in anti-AI-writing guides. The artifacts are read weeks later by someone with no context, and uniformity serves that reader better than personality.

## Considered options

- Adopt the Cursor `unslop` skill as is – a removal checklist plus "add soul" (first person, varied rhythm, deliberate imperfection). Rejected: removal framing tells an agent what not to do, and personality is noise in specs, ADRs and map nodes.
- Keep the rules where they are today – restated in eight files in slightly different words. Rejected: they had already drifted, and no file could be pointed at.

## Consequences

- The standard lives in one skill; every other skill points at it. Plugin prose must itself comply, so a sweep follows.
- A deterministic lint, `spechub lint-prose`, checks what a grep can check. It warns and never blocks, because sentence-length heuristics misfire in tables and code.
- The STE dictionary is licensed and is not reproduced; the plugin ships its own short vocabulary table instead.
