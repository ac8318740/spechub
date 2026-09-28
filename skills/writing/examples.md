# Writing examples

The `Write:` and `Not:` pair for each rule in `SKILL.md`, except rules 3 and 11, which keep theirs inline.

### 1. Cap a descriptive sentence at 25 words, and an instruction at 20 words (ASD-STE100)

- Write: The SessionStart hook creates the symlink at `~/.claude/spechub/bin/spechub`.
- Not: The SessionStart hook, which runs whenever a session begins and which the plugin installs for you, is responsible for creating the symlink that points at the CLI inside the current plugin cache.

### 2. Give each sentence one instruction (ASD-STE100)

- Write: Run the tests. Stage the spec files.
- Not: Run the tests and stage the spec files, then check the baseline count.

### 4. Break a paragraph at three sentences

- Write: Three sentences, then a new paragraph, even mid-argument.
- Not: A sixth sentence of setup inside the same block.

### 5. Open a paragraph with its point

- Write: Spec sync runs at commit time. It maps changed files to domains, then rewrites each spec.
- Not: Specs can drift. One option is to update them by hand. Spec sync runs at commit time.

### 6. Use one term for one meaning across a document (ASD-STE100)

- Write: The map holds nodes. Each node has a status.
- Not: The map holds nodes. Each item has a status.

### 7. Define a term of art in plain words, before you first use it

- Write: Work the frontier, the nodes ready to work now.
- Not: Work the frontier, the unblocked open nodes the tracker returns.

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

### 12. Use the short form

- Write: To stage the specs, run the commit skill. It warns because the cap is a heuristic.
- Not: In order to stage the specs, run the commit skill. It warns due to the fact that the cap is a heuristic.

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

### 18. Name the file, the number, and the actor

- Write: Three of the eleven skills restate these rules, `commit` among them.
- Not: Several files restate these rules.

### 19. Recommend one option and give the reason

- Write: Use the files backend. It needs no network.
- Not: There is a files backend and an issues backend. Both carry trade-offs.

### 20. State what a thing is, then stop

- Write: The skill holds the rules. The CLI checks them.
- Not: The skill is not just a style guide but a contract.
- Not: The hook writes the symlink rather than copying it.

### 21. List as many items as there are

- Write: The lint warns and never blocks.
- Not: The lint is fast, focused, and forgiving.

### 22. Name the thing a pronoun stands for

- Write: Only `/spechub:map` creates a map.
- Not: Only `/spechub:map` creates one.

### 23. Write for a developer who has never seen this repository

- Write: Node 14 asks which tracker backend ships first.
- Not: The node from this morning's grill.

- Write: the frontier, meaning the nodes you can work right now
- Not: work the frontier

### 24. State what you checked, and when

- Write: `spechub lint-prose` does not exist yet, as of 2026-08-22.
- Not: My knowledge has a cutoff, so this may have changed since.

### 25. Connect clauses with a period or a comma, and set an aside off with an en dash

- Write: The lint warns. It never blocks. The rule – a heuristic – misfires inside tables.
- Not: The same two sentences joined by an em dash, or by a colon in mid sentence.

- Write: proposals, designs, and tasks
- Not: proposals, designs and tasks

### 26. Write a heading in sentence case, and end a fragment with no period

- Write: `## Before you finish`, and a table cell that reads `make sure`
- Not: `## Before You Finish.`, and a table cell that reads `make sure.`

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
