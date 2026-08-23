# Glossary

**acknowledgement** – The receiver's ACCEPT or DECLINE, with a one-line reason, recorded by running `spechub handoff ack`. It is what lets the sender report the work as the receiver's.

**durable artifact** – Any text an agent writes that someone reads later without the conversation that produced it: architecture decision records, glossary entries, living specs and their functional requirements, map nodes, handoff files, READMEs and docs, and pull request bodies. Chat replies and commit subject lines are not durable artifacts.

**engaged** – A handoff watcher outcome: the receiving agent has not acknowledged, but has read the handoff file or started using work tools. The work is underway, and must not be relaunched elsewhere.
