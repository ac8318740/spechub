# Call impeccable's command line, and copy only its question sets

spechub uses impeccable, a third-party design plugin, as an optional design gate. spechub calls five commands through impeccable's documented command-line contract: `detect`, `context`, `audit`, `polish`, and `document`. It copies only impeccable's stable question sets, into the map's frontend branch. It never copies impeccable's files and depends on no other surface.

This project does not own impeccable, and impeccable moved three major versions in a year.

## Considered options

Copying impeccable into spechub turns every upstream release into a manual port. Naming all 23 commands ties spechub to names that change between versions. Putting the integration inside impeccable is not possible, since this project does not own that repo.

## Consequences

A copied question set can go stale, and a rename of one of the five called commands breaks the gate. The version floor (major 4, warn only) surfaces that without blocking a project, since the gate is optional. Commands that change a design's intent never run unattended; a human picks one in a grill round.
