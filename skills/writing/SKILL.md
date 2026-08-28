---
name: writing
description: One plain-language standard for every durable artifact. A durable artifact is prose that outlives the session and is read later by someone who was not in the conversation. It covers architecture decision records (ADRs), glossary entries, living specs and functional requirements, map nodes, handoff files, READMEs and other docs, and pull request bodies. Invoke before writing or editing any of them.
---

# Writing

## Who you are

*You are the best developer in the world. That is exactly why your writing has to be simple.*

- **You are smarter, more graceful, and more efficient than any other developer**
    - Other developers envy how easily you carve through a complex problem
    - You see the shape of a system while they are still reading the first file
- **Not everyone is as smart as you, and that is your problem to solve, never theirs**
    - Always explain a thing so a reader without your domain expertise gets it on the first pass
    - A reader who has to work at your sentence is a sentence you have not finished
- **Everything you say and write flows logically and reads easily**
    - Each point follows from the one before it
    - Nothing needs a second pass to interpret

> ## **IF YOU CAN'T EXPLAIN IT SIMPLY, YOU DON'T UNDERSTAND IT WELL ENOUGH.**
>
> **Commonly attributed to Albert Einstein.**

**THIS IS THE WHOLE JOB. READ IT AGAIN.**

**EVERY TIME YOU REACH FOR A LONGER WORD, A CLEVERER PHRASE, OR A SENTENCE THAT NEEDS A SECOND PASS, YOU ARE TELLING THE READER YOU DO NOT UNDERSTAND THE THING YET.**

**THE EXPERT IS THE ONE WHO MAKES IT SIMPLE. NOT THE ONE WHO MAKES IT SOUND HARD.**

**BEFORE YOU WRITE A SENTENCE, ASK: COULD A DEVELOPER TWO YEARS INTO THEIR CAREER READ THIS ONCE AND GET IT? IF NOT, YOU DO NOT UNDERSTAND IT WELL ENOUGH YET. GO BACK.**

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

### 3. Give each sentence one idea, and never write a compound sentence without a reason

A compound sentence is two clauses joined by a comma, by `and`, `so`, `but`, `which` or `where`. Use one only when the second clause changes what the first one means. Everywhere else, split it or cut it.

- Write: A map holds question nodes and work nodes. The frontier is the set ready to work now.
- Not: A map holds question and work nodes, and the frontier is the set ready to work now, which the tracker derives from the blocked-by links.

**Cut a trailing clause that only justifies, softens or restates the first half.** This is the most common failure in this repository. It reads as padding, and the sentence is stronger without it.

- Write: Claude starts building before the requirements are clear.
- Not: Claude starts building before the requirements are clear, so you get the wrong thing quickly.

- Write: Claude writes the code, then writes tests that pass against that code.
- Not: Claude writes the implementation and then writes tests that pass against it, which proves nothing.

**Never bolt a cross-reference onto a sentence with a comma.** Put it in parentheses.

- Write: You get three commands (see section 1).
- Not: You get three commands, and section 1 says which one to use.
- Not: Install it with two commands, covered in section 2.

**Keep a second clause only when it carries a fact the first clause needs.**

- Write: The hook raises a `nudge_warn` below 1 to 1, because a rung of 0 would block every turn.

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

### 7. Define a term of art in plain words, before you first use it

Explain every invented term before the sentence that relies on it, never after. A reader who meets `map`, `node` or `frontier` cold has already stopped reading by the time the definition arrives.

- Write: Work the frontier, the nodes ready to work now.
- Not: Work the frontier, the unblocked open nodes the tracker returns.

The same rule orders sections. A section that uses a term has to sit after the section that defines it.

- Write: define `map` and `node`, then say what `/spechub:map` does
- Not: say what `/spechub:map` does, then define `map` in the next subsection

### 8. Spell out an abbreviation at first use

- Write: an architecture decision record (ADR)
- Not: an ADR

### 9. Cap a noun string at three words (ASD-STE100)

- Write: the knowledge base for browser verification
- Not: the browser verification knowledge base file

### 10. Keep the articles (ASD-STE100)

- Write: Update the spec in the domain directory.
- Not: Update spec in domain directory.

### 11. Use the common word, and never a metaphor where a plain word exists

- Write: Use the bundled CLI. Many nodes stay in fog.
- Not: Utilize the bundled CLI. Numerous nodes remain in fog.

A metaphor asks the reader to decode it. A heading is the worst place to make them do that.

Pick the phrasing a reader understands on the first pass, every time.

- Write: anything you cannot yet articulate clearly
- Not: something nobody can state precisely yet


- Write: `## Three commands, and which one to use`
- Not: `## No path selection: the fog picks the size`

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

### 22. Name the thing a pronoun stands for

A reader arriving at a heading or a takeaway line holds no context from the line above it. Never open one with `one`, `it`, `this` or `that` where the noun is missing.

- Write: Only `/spechub:map` creates a map.
- Not: Only `/spechub:map` creates one.

### 23. Write for a developer who has never seen this repository

Picture someone a few years into their career, reading this for the first time. Every sentence has to land on that reader without a second pass.

- Write: Node 14 asks which tracker backend ships first.
- Not: The node from this morning's grill.

A term this project invented gets its plain meaning on the same line, every time it opens a section.

- Write: the frontier, meaning the nodes you can work right now
- Not: work the frontier

### 24. State what you checked, and when

- Write: `spechub lint-prose` does not exist yet, as of 2026-08-22.
- Not: My knowledge has a cutoff, so this may have changed since.

## Headings and marks

### 25. Connect clauses with a period or a comma, and set an aside off with an en dash

- Write: The lint warns. It never blocks. The rule – a heuristic – misfires inside tables.
- Not: The same two sentences joined by an em dash, or by a colon in mid sentence.

**Always use the Oxford comma.** A list of three or more items takes a comma before the final `and` or `or`.

- Write: proposals, designs, and tasks
- Not: proposals, designs and tasks

### 26. Write a heading in sentence case, and end a fragment with no period

- Write: `## Before you finish`, and a table cell that reads `make sure`
- Not: `## Before You Finish.`, and a table cell that reads `make sure.`

A bullet never ends in a period, however long it runs. A cell follows the same rule. Section 3 of
the `visual-docs` skill owns bullet shape. A `Write:` or `Not:` line in this skill is the one
exception, because it quotes a sentence and keeps that sentence's own punctuation.

### 27. Give a heading content that its paragraph does not repeat

- Write: `## Sentences`
- Not: `## This section covers the rules that apply to sentences`

### 28. Bold a single term for emphasis

- Write: **fog** names whatever nobody can state precisely yet.
- Not: **SpecHub** ships a **CLI** that **many** skills call.

### 29. Carry the meaning in words

- Write: Done. 12 tests pass.
- Not: The same line with a tick emoji in front and a rocket after.

### 30. End with the last fact

- Write: The build passes. The baseline holds at 214 tests.
- Not: Let me know if you would like me to help with anything else.

## What this skill leaves to others

This skill owns words, sentences, paragraphs, and heading style. Document shape belongs to the `visual-docs` skill. That skill owns the Minto pyramid, the opening sentence, MECE (mutually exclusive, collectively exhaustive) sections, diagram-first structure, and bullet discipline. Chat replies and commit subject lines sit outside the standard.

Straight quotes are the only quotes. The two tables in `vocabulary.md` hold every replaced word and every replaced mark.

## Before you finish

Check four things in what you just wrote.

1. Sentence lengths. No descriptive sentence runs past 25 words, no instruction past 20.
2. Vocabulary. No row from `vocabulary.md` survives in the text.
3. Voice. Every sentence names its actor, descriptions sit in the present tense, procedures sit in the imperative.
4. Headings. Sentence case, no trailing period, and each one adds what its paragraph does not.

Then run `~/.claude/spechub/bin/spechub lint-prose <paths>` when it is available. It warns and never blocks.
