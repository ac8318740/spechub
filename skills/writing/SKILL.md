---
name: writing
description: One plain-language standard for every durable artifact. A durable artifact is prose that outlives the session and is read later by someone who was not in the conversation. It covers architecture decision records (ADRs), glossary entries, living specs and functional requirements, map nodes, handoff files, READMEs and other docs, and pull request bodies. Invoke before writing or editing any of them.
---

# Writing

SpecHub adopts the writing rules of ASD-STE100 (Simplified Technical English), not its licensed dictionary. ASD-STE100 is an aerospace standard for controlled technical writing. The file `vocabulary.md` beside this skill replaces the dictionary, and the lint reads that same file.

Every rule below is a way to write. Each carries one pair of lines, `Write:` and `Not:`.

## Sentences

An instruction is a numbered step, a procedure line, or a handoff next action.

### 1. Cap a descriptive sentence at 25 words, and an instruction at 20 words (ASD-STE100)

- Write: The SessionStart hook creates the symlink at `~/.claude/spechub/bin/spechub`.
- Not: The SessionStart hook, which runs whenever a session begins and which the plugin installs for you, is responsible for creating the symlink that points at the CLI inside the current plugin cache.

`spechub lint-prose` checks both caps. The 20-word cap applies to an ordered list item, written `1.` or `1)`. An unordered bullet keeps the 25-word cap.

### 2. Give each sentence one instruction (ASD-STE100)

- Write: Run the tests. Stage the spec files.
- Not: Run the tests and stage the spec files, then check the baseline count.

### 3. Give each sentence one idea

- Write: A map holds question nodes and work nodes. The frontier is the set ready to work now.
- Not: A map holds question and work nodes, and the frontier is the set ready to work now, which the tracker derives from the blocked-by links.

### 4. Break a paragraph at six sentences (ASD-STE100)

- Write: Six sentences, then a new paragraph, even mid-argument.
- Not: A ninth sentence of setup inside the same block.

### 5. Open a paragraph with its point

- Write: Spec sync runs at commit time. It maps changed files to domains, then rewrites each spec.
- Not: Specs can drift. One option is to update them by hand. Spec sync runs at commit time.

## Words

### 6. Use one term for one meaning across a document (ASD-STE100)

- Write: The map holds nodes. Each node has a status.
- Not: The map holds nodes. Each item has a status.

### 7. Define a term of art in plain words, at first use and in a glossary entry

- Write: Work the frontier, the nodes ready to work now.
- Not: Work the frontier, the unblocked open nodes the tracker returns.

### 8. Spell out an abbreviation at first use

- Write: an architecture decision record (ADR)
- Not: an ADR

### 9. Cap a noun string at three words (ASD-STE100)

- Write: the knowledge base for browser verification
- Not: the browser verification knowledge base file

### 10. Keep the articles (ASD-STE100)

- Write: Update the spec in the domain directory.
- Not: Update spec in domain directory.

### 11. Use the common word

- Write: Use the bundled CLI. Many nodes stay in fog.
- Not: Utilize the bundled CLI. Numerous nodes remain in fog.

### 12. Use the short form

- Write: To stage the specs, run the commit skill. It warns because the cap is a heuristic.
- Not: In order to stage the specs, run the commit skill. It warns due to the fact that the cap is a heuristic.

## Voice

### 13. Name the actor and put it in front of the verb (ASD-STE100)

- Write: The task-checker runs the full suite.
- Not: The full suite is run.

### 14. Write descriptions in the present tense and procedures in the imperative (ASD-STE100)

- Write: The hook writes the symlink. Run the hook after you install the plugin.
- Not: The hook will have written the symlink. You should then probably run it.

### 15. Make a claim once, at the strength the evidence supports

- Write: The cap misfires inside tables.
- Not: It may possibly be the case that the cap could sometimes misfire inside tables.

### 16. Name the source of a claim

- Write: ASD-STE100 caps a descriptive sentence at 25 words.
- Not: Experts believe that shorter sentences read better.

### 17. Describe a thing by what it does

- Write: The tunnel forwards port 19988 to Chrome on the laptop.
- Not: The tunnel offers a seamless, robust bridge to your browser.

## Structure

### 18. Name the file, the number, and the actor

- Write: Three of the eleven skills restate these rules, `commit` among them.
- Not: Several files restate these rules.

### 19. Recommend one option and give the reason

- Write: Use the files backend. It needs no network.
- Not: There is a files backend and an issues backend. Both carry trade-offs.

### 20. State what a thing is

- Write: The skill holds the rules. The CLI checks them.
- Not: The skill is not just a style guide but a contract.

### 21. List as many items as there are

- Write: The lint warns and never blocks.
- Not: The lint is fast, focused, and forgiving.

### 22. Write for a reader who was not in the conversation and reads weeks later

- Write: Node 14 asks which tracker backend ships first.
- Not: The node from this morning's grill.

### 23. State what you checked, and when

- Write: `spechub lint-prose` does not exist yet, as of 2026-08-22.
- Not: My knowledge has a cutoff, so this may have changed since.

## Headings and marks

### 24. Connect clauses with a period or a comma, and set an aside off with an en dash

- Write: The lint warns. It never blocks. The rule – a heuristic – misfires inside tables.
- Not: The same two sentences joined by an em dash, or by a colon in mid sentence.

### 25. Write a heading in sentence case, and end a fragment with no period

- Write: `## Before you finish`, and a table cell that reads `make sure`
- Not: `## Before You Finish.`, and a table cell that reads `make sure.`

A bullet never ends in a period, however long it runs. A cell follows the same rule. Section 3 of
the `visual-docs` skill owns bullet shape. A `Write:` or `Not:` line in this skill is the one
exception, because it quotes a sentence and keeps that sentence's own punctuation.

### 26. Give a heading content that its paragraph does not repeat

- Write: `## Sentences`
- Not: `## This section covers the rules that apply to sentences`

### 27. Bold a single term for emphasis

- Write: **fog** names whatever nobody can state precisely yet.
- Not: **SpecHub** ships a **CLI** that **many** skills call.

### 28. Carry the meaning in words

- Write: Done. 12 tests pass.
- Not: The same line with a tick emoji in front and a rocket after.

### 29. End with the last fact

- Write: The build passes. The baseline holds at 214 tests.
- Not: Let me know if you would like me to help with anything else.

## What this skill leaves to others

This skill owns words, sentences, paragraphs, and heading style. Document shape belongs to the `visual-docs` skill. That skill owns the Minto pyramid, SCQA (situation, complication, question, answer) openings, MECE (mutually exclusive, collectively exhaustive) sections, diagram-first structure, and bullet discipline. Chat replies and commit subject lines sit outside the standard.

Straight quotes are the only quotes. The two tables in `vocabulary.md` hold every replaced word and every replaced mark.

## Before you finish

Check four things in what you just wrote.

1. Sentence lengths. No descriptive sentence runs past 25 words, no instruction past 20.
2. Vocabulary. No row from `vocabulary.md` survives in the text.
3. Voice. Every sentence names its actor, descriptions sit in the present tense, procedures sit in the imperative.
4. Headings. Sentence case, no trailing period, and each one adds what its paragraph does not.

Then run `~/.claude/spechub/bin/spechub lint-prose <paths>` when it is available. It warns and never blocks.
