import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseVocabulary, lintProse, isVocabularyFile, type VocabularyEntry } from './prose.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../');

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function paragraphOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} is short.`).join('\n') + '\n';
}

describe('parseVocabulary', () => {
  const markdown = `<!--
\`spechub lint-prose\` reads this layout. Ignore this comment entirely.
-->

# Vocabulary

## Words

| Avoid | Write instead | Note |
| --- | --- | --- |
| utilize | use | |
| interplay | - | name the two things and how they meet |
|  facilitate  |  help  |  keep it simple  |
| widen | – | not the delete sentinel, an en dash |

## Marks

| Avoid | Write instead | Note |
| --- | --- | --- |
| — | en dash with spaces | |
| … | ... | or a period |
`;

  const { entries, warnings } = parseVocabulary(markdown);

  it('parses a plain replacement entry under Words', () => {
    const entry = entries.find((e) => e.avoid === 'utilize');
    expect(entry).toBeDefined();
    expect(entry!.writeInstead).toBe('use');
    expect(entry!.note).toBe('');
    expect(entry!.section).toBe('words');
  });

  it('treats an ASCII hyphen cell as the delete sentinel, null writeInstead', () => {
    const entry = entries.find((e) => e.avoid === 'interplay');
    expect(entry!.writeInstead).toBeNull();
    expect(entry!.note).toBe('name the two things and how they meet');
    expect(entry!.section).toBe('words');
  });

  it('trims whitespace from every cell', () => {
    const entry = entries.find((e) => e.avoid === 'facilitate');
    expect(entry!.writeInstead).toBe('help');
    expect(entry!.note).toBe('keep it simple');
  });

  it('does not treat an en dash or em dash as the delete sentinel', () => {
    const entry = entries.find((e) => e.avoid === 'widen');
    expect(entry!.writeInstead).toBe('–');
  });

  it('assigns section "marks" to entries under the Marks heading', () => {
    const dash = entries.find((e) => e.avoid === '—');
    expect(dash).toBeDefined();
    expect(dash!.section).toBe('marks');
    expect(dash!.writeInstead).toBe('en dash with spaces');

    const ellipsis = entries.find((e) => e.avoid === '…');
    expect(ellipsis!.section).toBe('marks');
    expect(ellipsis!.writeInstead).toBe('...');
  });

  it('skips the header row and the separator row, and ignores text outside the tables', () => {
    expect(entries.some((e) => e.avoid === 'avoid')).toBe(false);
    expect(entries.some((e) => e.avoid === '---')).toBe(false);
    expect(entries.some((e) => e.avoid.includes('spechub lint-prose'))).toBe(false);
    expect(entries).toHaveLength(6);
  });

  it('produces no warnings for a well-formed vocabulary file', () => {
    expect(warnings).toEqual([]);
  });
});

describe('parseVocabulary: malformed rows', () => {
  it('drops a row with the wrong number of columns and warns with its line number', () => {
    const lines = [
      '# Vocabulary',
      '',
      '## Words',
      '',
      '| Avoid | Write instead | Note |',
      '| --- | --- | --- |',
      '| utilize | use | |',
      '| broken | only two |',
      '| facilitate | help | |',
    ];
    const markdown = lines.join('\n') + '\n';
    const { entries, warnings } = parseVocabulary(markdown);

    expect(entries.some((e) => e.avoid === 'broken')).toBe(false);
    expect(entries.some((e) => e.avoid === 'utilize')).toBe(true);
    expect(entries.some((e) => e.avoid === 'facilitate')).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].line).toBe(8);
  });

  it('produces one warning per dropped row', () => {
    const lines = [
      '## Words',
      '',
      '| Avoid | Write instead | Note |',
      '| --- | --- | --- |',
      '| first-broken | too | many | columns |',
      '| utilize | use | |',
      '| second-broken |',
    ];
    const markdown = lines.join('\n') + '\n';
    const { entries, warnings } = parseVocabulary(markdown);

    expect(entries.some((e) => e.avoid === 'utilize')).toBe(true);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.line)).toEqual([5, 7]);
  });
});

describe('parseVocabulary: escaped pipe in a table cell', () => {
  it('keeps an escaped pipe as literal cell content instead of splitting into an extra column', () => {
    const lines = [
      '## Words',
      '',
      '| Avoid | Write instead | Note |',
      '| --- | --- | --- |',
      '| a\\|b | use | note here |',
    ];
    const markdown = lines.join('\n') + '\n';
    const { entries, warnings } = parseVocabulary(markdown);

    const entry = entries.find((e) => e.avoid === 'a|b');
    expect(entry).toBeDefined();
    expect(entry!.writeInstead).toBe('use');
    expect(entry!.note).toBe('note here');
    expect(warnings).toEqual([]);
  });
});

describe('parseVocabulary: the shipped vocabulary file', () => {
  const vocabularyPath = resolve(repoRoot, 'skills/writing/vocabulary.md');
  const markdown = readFileSync(vocabularyPath, 'utf-8');
  const { entries, warnings } = parseVocabulary(markdown);

  it('produces no warnings for the shipped file', () => {
    expect(warnings).toEqual([]);
  });

  it('has at least 60 entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(60);
  });

  it('maps "utilize" to "use"', () => {
    const entry = entries.find((e) => e.avoid === 'utilize');
    expect(entry).toBeDefined();
    expect(entry!.writeInstead).toBe('use');
  });
});

describe('lintProse: vocabulary rule', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
    { avoid: 'in order to', writeInstead: 'to', note: '', section: 'words' },
    { avoid: 'cutting-edge', writeInstead: 'new', note: '', section: 'words' },
    { avoid: 'interplay', writeInstead: null, note: 'name the two things', section: 'words' },
  ];

  it('matches a whole word case-insensitively', () => {
    const findings = lintProse('We should Utilize this.\nutilize it again.\n', vocab).filter(
      (f) => f.rule === 'vocabulary'
    );
    expect(findings).toHaveLength(2);
    expect(findings[0].line).toBe(1);
    expect(findings[1].line).toBe(2);
  });

  it('does not match a substring inside a longer word', () => {
    const findings = lintProse(
      'We should not confuse utilizes or reutilize with the flagged word.\n',
      vocab
    ).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(0);
  });

  it('matches a multi-word phrase', () => {
    const findings = lintProse('In order to finish, submit it.\n', vocab).filter(
      (f) => f.rule === 'vocabulary'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].message.toLowerCase()).toContain('in order to');
  });

  it('matches a hyphenated entry', () => {
    const findings = lintProse('This is a cutting-edge design.\n', vocab).filter(
      (f) => f.rule === 'vocabulary'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message.toLowerCase()).toContain('cutting-edge');
  });

  it('reports one finding per occurrence, each carrying its line number', () => {
    const findings = lintProse('utilize this, then utilize that.\n', vocab).filter(
      (f) => f.rule === 'vocabulary'
    );
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.line === 1)).toBe(true);
  });

  it('names the replacement in the message when there is one', () => {
    const findings = lintProse('utilize it.\n', vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(1);
    expect(findings[0].message.toLowerCase()).toContain('utilize');
    expect(findings[0].message.toLowerCase()).toContain('use');
  });

  it('names the avoided word for a delete-sentinel entry, with delete wording and the note text', () => {
    const findings = lintProse('The interplay of parts.\n', vocab).filter(
      (f) => f.rule === 'vocabulary'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message.toLowerCase()).toContain('interplay');
    expect(findings[0].message.toLowerCase()).toContain('cut it');
    expect(findings[0].message).toContain('name the two things');
  });
});

describe('lintProse: overlapping vocabulary entries', () => {
  it('flags only the longest match when two entries overlap on the same text', () => {
    const vocab: VocabularyEntry[] = [
      { avoid: 'in order to', writeInstead: 'to', note: '', section: 'words' },
      { avoid: 'order to', writeInstead: null, note: 'shorter overlapping entry', section: 'words' },
    ];
    const findings = lintProse('In order to finish, submit it.\n', vocab).filter(
      (f) => f.rule === 'vocabulary'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message.toLowerCase()).toContain('in order to');
  });
});

describe('lintProse: mark rule', () => {
  const marks: VocabularyEntry[] = [
    { avoid: '—', writeInstead: 'en dash with spaces', note: '', section: 'marks' },
    { avoid: '“', writeInstead: '"', note: '', section: 'marks' },
    { avoid: '”', writeInstead: '"', note: '', section: 'marks' },
    { avoid: '‘', writeInstead: "'", note: '', section: 'marks' },
    { avoid: '’', writeInstead: "'", note: '', section: 'marks' },
    { avoid: '…', writeInstead: '...', note: '', section: 'marks' },
  ];

  it.each([
    ['—', 'em dash'],
    ['“', 'opening curly double quote'],
    ['”', 'closing curly double quote'],
    ['‘', 'opening curly single quote'],
    ['’', 'closing curly single quote'],
    ['…', 'ellipsis'],
  ])('flags %s (%s)', (mark) => {
    const findings = lintProse(`A${mark}B.\n`, marks).filter((f) => f.rule === 'mark');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].message).toContain(mark);
  });

  it('matches anywhere in the line, not only as a whole word', () => {
    const findings = lintProse('word—word\n', marks).filter((f) => f.rule === 'mark');
    expect(findings).toHaveLength(1);
  });

  it('does not flag an en dash, which stays', () => {
    const findings = lintProse('A – B — C\n', marks).filter((f) => f.rule === 'mark');
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('—');
  });
});

describe('lintProse: emoji rule', () => {
  it('flags a rocket, a surrogate-pair emoji above the BMP', () => {
    const findings = lintProse('Ready for launch \u{1F680} now.\n', []).filter(
      (f) => f.rule === 'emoji'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].message).toContain('\u{1F680}');
  });

  it('flags a heart as one finding, both bare and followed by the variation selector', () => {
    const bare = lintProse('Great job \u{2764} team.\n', []).filter((f) => f.rule === 'emoji');
    expect(bare).toHaveLength(1);
    expect(bare[0].line).toBe(1);

    const withSelector = lintProse('Great job \u{2764}\u{FE0F} team.\n', []).filter(
      (f) => f.rule === 'emoji'
    );
    expect(withSelector).toHaveLength(1);
    expect(withSelector[0].line).toBe(1);
  });

  it('flags a grinning face, a second surrogate-pair emoji', () => {
    const findings = lintProse('So happy \u{1F600} today.\n', []).filter(
      (f) => f.rule === 'emoji'
    );
    expect(findings).toHaveLength(1);
  });

  it('counts a skin-tone modifier sequence as one finding, not one per code point', () => {
    const findings = lintProse('Nice \u{1F44D}\u{1F3FD} work.\n', []).filter(
      (f) => f.rule === 'emoji'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  it('counts a ZWJ family sequence as one finding, not one per code point', () => {
    const findings = lintProse(
      'Photo: \u{1F468}‍\u{1F469}‍\u{1F466} smiling.\n',
      []
    ).filter((f) => f.rule === 'emoji');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  it('counts a man-technologist ZWJ sequence as one finding, not one per code point', () => {
    const findings = lintProse('Hello \u{1F468}‍\u{1F4BB} friend.\n', []).filter(
      (f) => f.rule === 'emoji'
    );
    expect(findings).toHaveLength(1);
  });

  it('does not flag the degree sign, which is category So but not Extended_Pictographic', () => {
    const findings = lintProse('It is 20\u{00B0} outside.\n', []).filter(
      (f) => f.rule === 'emoji'
    );
    expect(findings).toHaveLength(0);
  });

  it.each([
    ['\u{00A9}', 'copyright sign'],
    ['\u{00AE}', 'registered sign'],
    ['\u{2122}', 'trade mark sign'],
  ])(
    'does not flag %s (%s), even though it is Extended_Pictographic, because it reads as a legal mark',
    (mark) => {
      const findings = lintProse(`Acme ${mark} Inc.\n`, []).filter((f) => f.rule === 'emoji');
      expect(findings).toHaveLength(0);
    }
  );

  it.each([
    ['\u{251C}', 'box drawing light vertical and right'],
    ['\u{2500}', 'box drawing light horizontal'],
    ['\u{2514}', 'box drawing light up and right'],
  ])('does not flag %s (%s), used in ASCII diagrams', (mark) => {
    const findings = lintProse(`${mark}-- child\n`, []).filter((f) => f.rule === 'emoji');
    expect(findings).toHaveLength(0);
  });

  it('does not flag an ASCII caret', () => {
    const findings = lintProse('A line with a caret ^ in it.\n', []).filter(
      (f) => f.rule === 'emoji'
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag a lone ASCII backtick', () => {
    // Unpaired on its own line, so it cannot be read as opening an inline code span.
    const findings = lintProse('A line with a lone backtick ` in it.\n', []).filter(
      (f) => f.rule === 'emoji'
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag ordinary punctuation, ASCII, accented Latin letters, or an en dash', () => {
    const findings = lintProse(
      'Café, naïve – yes! Is that so, plain, text?\n',
      []
    ).filter((f) => f.rule === 'emoji');
    expect(findings).toHaveLength(0);
  });

  it.each([
    ['\u{00A8}', 'diaeresis'],
    ['\u{00B4}', 'acute accent'],
    ['\u{00AF}', 'macron'],
  ])('does not flag %s (%s), no longer treated as emoji under the new rule', (mark) => {
    const findings = lintProse(`A${mark}B.\n`, []).filter((f) => f.rule === 'emoji');
    expect(findings).toHaveLength(0);
  });
});

describe('lintProse: sentence-length rule', () => {
  it('does not flag exactly 25 words in ordinary prose', () => {
    const findings = lintProse(`${words(25)}.\n`, []).filter(
      (f) => f.rule === 'sentence-length'
    );
    expect(findings).toHaveLength(0);
  });

  it('flags a sentence of more than 25 words in ordinary prose', () => {
    const findings = lintProse(`${words(26)}.\n`, []).filter(
      (f) => f.rule === 'sentence-length'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].message).toContain('26');
  });

  it.each(['-', '*', '+'])(
    'does not flag 23 words in an unordered list item marked "%s", the ordinary 25-word cap applies',
    (marker) => {
      const findings = lintProse(`${marker} ${words(23)}.\n`, []).filter(
        (f) => f.rule === 'sentence-length'
      );
      expect(findings).toHaveLength(0);
    }
  );

  it.each(['-', '*', '+'])(
    'flags 26 words in an unordered list item marked "%s"',
    (marker) => {
      const findings = lintProse(`${marker} ${words(26)}.\n`, []).filter(
        (f) => f.rule === 'sentence-length'
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('26');
    }
  );

  it.each(['1.', '1)'])(
    'flags 23 words in an ordered list item marked "%s", the narrower 20-word cap applies',
    (marker) => {
      const findings = lintProse(`${marker} ${words(23)}.\n`, []).filter(
        (f) => f.rule === 'sentence-length'
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain('23');
    }
  );

  it.each(['1.', '1)'])('does not flag exactly 20 words in an ordered list item marked "%s"', (marker) => {
    const findings = lintProse(`${marker} ${words(20)}.\n`, []).filter(
      (f) => f.rule === 'sentence-length'
    );
    expect(findings).toHaveLength(0);
  });

  it.each(['1.', '1)'])('flags an ordered list item marked "%s" over 20 words', (marker) => {
    const findings = lintProse(`${marker} ${words(21)}.\n`, []).filter(
      (f) => f.rule === 'sentence-length'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('21');
  });

  it('treats "?" and "!" as sentence terminators, same as "."', () => {
    const findings = lintProse(`${words(26)}?\n${words(26)}!\n`, []).filter(
      (f) => f.rule === 'sentence-length'
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
  });

  it.each(['e.g.', 'i.e.', 'vs.', 'etc.', 'cf.', 'Dr.', 'Mr.', 'Ms.', 'Fig.', 'No.'])(
    'does not split a sentence after the abbreviation "%s", counting it as one long sentence',
    (abbrev) => {
      // The following word starts with a CAPITAL letter, so the only thing
      // preventing a split here is the abbreviation itself. Without it, the
      // capital letter would tell the splitter to start a new sentence.
      const text = `${words(15)} ${abbrev} ${capitalize(words(15))}.\n`;
      const findings = lintProse(text, []).filter((f) => f.rule === 'sentence-length');
      expect(findings).toHaveLength(1);
      expect(findings[0].line).toBe(1);
      expect(findings[0].message).toContain('31');
    }
  );

  it('control: a made-up "abbreviation" followed by a capitalized word DOES split into two sentences', () => {
    // Proves the cases above are real: an unrecognized abbreviation-shaped
    // token ("zzz.") followed by a capital letter must NOT suppress the
    // split, unlike the real abbreviations tested above. Both halves are
    // sized to individually clear the 25-word prose cap, so a correct split
    // yields two findings; a wrongly-suppressed split would instead yield a
    // single finding covering the combined 57-word run-on.
    const text = `${words(30)} zzz. ${capitalize(words(26))}.\n`;
    const findings = lintProse(text, []).filter((f) => f.rule === 'sentence-length');
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.line === 1)).toBe(true);
    // First sentence: 30 words + "zzz." = 31 tokens.
    expect(findings[0].message).toContain('31');
    // Second sentence: capitalized words(26) = 26 tokens.
    expect(findings[1].message).toContain('26');
  });

  it('does not split a sentence after a single capital letter followed by a period, as in a middle initial', () => {
    const text = `${words(15)} John A. Smith ${words(12)}.\n`;
    const findings = lintProse(text, []).filter((f) => f.rule === 'sentence-length');
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('30');
  });

  it('does not split a sentence when the character right after the period is lowercase', () => {
    const text = `${words(15)} done. ${words(14)}.\n`;
    const findings = lintProse(text, []).filter((f) => f.rule === 'sentence-length');
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('30');
  });

  it.each(['#', '##', '###', '####', '#####', '######'])(
    'never flags a "%s" heading line, however many words it runs to',
    (hashes) => {
      const findings = lintProse(`${hashes} ${words(40)}\n`, []).filter(
        (f) => f.rule === 'sentence-length'
      );
      expect(findings).toHaveLength(0);
    }
  );

  it('still flags a deny-list vocabulary word inside a heading', () => {
    const vocab: VocabularyEntry[] = [
      { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
    ];
    const findings = lintProse('## Please utilize this pattern\n', vocab).filter(
      (f) => f.rule === 'vocabulary'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });
});

describe('lintProse: paragraph-length rule', () => {
  it('does not flag a paragraph of exactly 3 sentences', () => {
    const findings = lintProse(paragraphOf(3), []).filter((f) => f.rule === 'paragraph-length');
    expect(findings).toHaveLength(0);
  });

  it('flags a paragraph of more than 3 sentences once, at the paragraph\'s first line', () => {
    const findings = lintProse(paragraphOf(4), []).filter((f) => f.rule === 'paragraph-length');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  it('flags only the offending paragraph, at that paragraph\'s own first line', () => {
    const text = `${paragraphOf(3)}\n${paragraphOf(4)}`;
    const findings = lintProse(text, []).filter((f) => f.rule === 'paragraph-length');
    expect(findings).toHaveLength(1);
    // paragraphOf(3) occupies lines 1-3, line 4 is the blank separator,
    // so the second paragraph's first line is line 5.
    expect(findings[0].line).toBe(5);
  });

  it('keeps a paragraph at three sentences when all three contain abbreviations', () => {
    const text = [
      'Sentence number 1 mentions Dr. Smith briefly.',
      'Sentence number 2 compares this vs. that directly.',
      'Sentence number 3 gives an example, e.g. this one.',
    ].join('\n') + '\n';
    const findings = lintProse(text, []).filter((f) => f.rule === 'paragraph-length');
    expect(findings).toHaveLength(0);
  });
});

describe('lintProse: passive-voice rule', () => {
  it.each([
    'The full suite is run.',
    'The specs are updated.',
    'it was created.',
    'it has been written.',
  ])('flags "%s"', (sentence) => {
    const findings = lintProse(`${sentence}\n`, []).filter((f) => f.rule === 'passive-voice');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  it.each(['The build is running.', 'This is a heuristic.', 'The checker is fast.'])(
    'does not flag "%s"',
    (sentence) => {
      const findings = lintProse(`${sentence}\n`, []).filter((f) => f.rule === 'passive-voice');
      expect(findings).toHaveLength(0);
    }
  );

  it.each([
    'The team is tired.',
    'The reviewers are excited.',
    'Everyone was bored.',
    'The engineer is talented.',
    'The terrain is rugged.',
    'The value is undefined.',
    'The set is unordered.',
    'The candidate is qualified.',
    'The candidate is experienced.',
    'The report is detailed.',
  ])('does not flag the "-ed" adjective in "%s"', (sentence) => {
    const findings = lintProse(`${sentence}\n`, []).filter((f) => f.rule === 'passive-voice');
    expect(findings).toHaveLength(0);
  });

  // These three predicate adjectives are NOT in the implementation's
  // exception list (unlike the ten above, which merely retype it). They are
  // EXPECTED TO FAIL: the passive-voice heuristic over-fires on them. This
  // documents the heuristic's real false-positive surface rather than
  // hiding it; it.fails keeps the suite green while the gap stays visible.
  it.fails('does not flag the "-ed" adjective in "The candidate is skilled."', () => {
    const findings = lintProse('The candidate is skilled.\n', []).filter(
      (f) => f.rule === 'passive-voice'
    );
    expect(findings).toHaveLength(0);
  });

  it.fails('does not flag the "-ed" adjective in "The candidate is gifted."', () => {
    const findings = lintProse('The candidate is gifted.\n', []).filter(
      (f) => f.rule === 'passive-voice'
    );
    expect(findings).toHaveLength(0);
  });

  it.fails('does not flag the "-ed" adjective in "The candidate is seasoned."', () => {
    const findings = lintProse('The candidate is seasoned.\n', []).filter(
      (f) => f.rule === 'passive-voice'
    );
    expect(findings).toHaveLength(0);
  });

  it.each([
    'It is not run.',
    'The doc is being written.',
    'The feature is well-tested.',
    'The report has been written.',
    'The tests were modified.',
  ])(
    'still flags "%s", where a modifier sits between the be-form and the participle',
    (sentence) => {
      const findings = lintProse(`${sentence}\n`, []).filter((f) => f.rule === 'passive-voice');
      expect(findings).toHaveLength(1);
    }
  );
});

describe('lintProse: frontmatter skip region', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
  ];

  it('skips properly closed YAML frontmatter, between the first "---" line and its closing "---"', () => {
    const text = [
      '---',
      'title: Utilize this in frontmatter',
      '---',
      'Utilize this outside frontmatter.',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
  });

  it('reports a violation on line 3 when the opening "---" is never closed', () => {
    const text = ['---', 'Nothing closes this block.', 'Utilize this on line three.'].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  it('treats "---" as a thematic break, not frontmatter, when the lines between are not YAML', () => {
    const text = [
      '---',
      'Utilize this, ordinary prose rather than a YAML key.',
      '---',
      'Utilize this after the second dash line.',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings.map((f) => f.line)).toEqual([2, 4]);
  });
});

describe('lintProse: unterminated code fence', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
  ];

  it('reports one unterminated-fence finding at the opening line, and skips everything after as code', () => {
    const text = [
      'Utilize this outside.',
      '```js',
      'utilize this inside, never linted.',
      'more code, still no closing fence.',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab);

    const fenceFindings = findings.filter((f) => f.rule === 'unterminated-fence');
    expect(fenceFindings).toHaveLength(1);
    expect(fenceFindings[0].line).toBe(2);
    expect(fenceFindings[0].message).toContain('unterminated code fence opened at line 2');

    const vocabFindings = findings.filter((f) => f.rule === 'vocabulary');
    expect(vocabFindings).toHaveLength(1);
    expect(vocabFindings[0].line).toBe(1);
  });

  it('does not report unterminated-fence for a properly closed fence', () => {
    const text = ['```js', 'code here', '```'].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'unterminated-fence');
    expect(findings).toHaveLength(0);
  });
});

describe('lintProse: skip regions', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
  ];

  it('skips a backtick-fenced code block, including one with a language tag', () => {
    const text = [
      'Utilize this outside the fence.',
      '```js',
      'utilize this inside the fence.',
      '```',
      'Utilize this outside again.',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line)).toEqual([1, 5]);
  });

  it('skips a tilde-fenced code block', () => {
    const text = [
      'Utilize this outside the fence.',
      '~~~',
      'utilize this inside the fence.',
      '~~~',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  it('skips a line whose first non-whitespace character is a table pipe', () => {
    const text = [
      'Utilize this outside a table.',
      '| Utilize this looks like a table row |',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  it('skips only the span of inline code, still checking the rest of the line', () => {
    const text = 'Utilize this and `utilize inside code` and utilize again.\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.line === 1)).toBe(true);
  });
});

describe('lintProse: HTML comment skip region', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
  ];

  it('skips a single-line HTML comment', () => {
    const text = 'Utilize this outside.\n<!-- utilize this inside a comment -->\nUtilize again.\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings.map((f) => f.line)).toEqual([1, 3]);
  });

  it('skips an HTML comment spanning several lines', () => {
    const text = [
      'Utilize this outside.',
      '<!--',
      'utilize this on one comment line.',
      'utilize this on another comment line.',
      '-->',
      'Utilize this after the comment.',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings.map((f) => f.line)).toEqual([1, 6]);
  });
});

describe('lintProse: indented code block skip region', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
  ];

  it('skips a four-space-indented line that follows a blank line, an indented code block', () => {
    const text = [
      'Utilize this in prose.',
      '',
      '    utilize this, an indented code block.',
      '',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  it('still lints a four-space-indented continuation line inside a list item', () => {
    const text = [
      '- utilize this list item text',
      '    utilize this continuation line',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
  });
});

describe('lintProse: pipe-less table skip region', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
  ];

  it('skips a table recognized by its delimiter row, even without leading pipes', () => {
    const text = [
      'Utilize this in prose.',
      'Avoid | Write instead | Note',
      '--- | --- | ---',
      'utilize | use |',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });
});

describe('lintProse: double-backtick inline span', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
  ];

  it('skips a double-backtick span, which can hold a literal backtick', () => {
    const text = 'Utilize this and ``a `utilize` backtick span`` and utilize again.\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.line === 1)).toBe(true);
  });
});

describe('lintProse: long fence skip region', () => {
  const vocab: VocabularyEntry[] = [
    { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
  ];

  it('closes a four-backtick fence only on a run of four or more, so a three-backtick line inside stays code', () => {
    const text = [
      'Utilize this outside.',
      '````',
      'utilize this inside.',
      '```',
      'utilize this too, still inside.',
      '````',
      'Utilize this outside again.',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings.map((f) => f.line)).toEqual([1, 7]);
  });
});

describe('lintProse: blockquote prefix stripped before the list marker is read', () => {
  it('reads "> 1. ..." as an ordered list item, so the 20-word cap applies', () => {
    const findings = lintProse(`> 1. ${words(23)}.\n`, []).filter(
      (f) => f.rule === 'sentence-length'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('23');
  });

  it('does not flag "> 1. ..." at exactly 20 words', () => {
    const findings = lintProse(`> 1. ${words(20)}.\n`, []).filter(
      (f) => f.rule === 'sentence-length'
    );
    expect(findings).toHaveLength(0);
  });
});

describe('lintProse: column numbers count code points', () => {
  it('reports the human column, not the UTF-16 offset, after a surrogate-pair emoji earlier on the line', () => {
    const vocab: VocabularyEntry[] = [
      { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
    ];
    // Rocket emoji: one code point, two UTF-16 units. Then a space, then "utilize".
    const text = '\u{1F680} utilize this.\n';
    const findings = lintProse(text, vocab).filter((f) => f.rule === 'vocabulary');
    expect(findings).toHaveLength(1);
    // Code points: 1 = rocket, 2 = space, 3 = start of "utilize".
    expect(findings[0].column).toBe(3);
  });
});

describe('isVocabularyFile', () => {
  it('returns true for identical absolute paths', () => {
    const path = resolve(repoRoot, 'skills/writing/vocabulary.md');
    expect(isVocabularyFile(path, path)).toBe(true);
  });

  it('returns true for two absolute paths built independently from the same fixed root', () => {
    // Built by hand from a fixed root string, not derived from calling the
    // same resolution step the implementation itself performs first -
    // otherwise the assertion would just be resolve(x) === resolve(resolve(x)).
    const root = '/repo/checkout';
    const a = `${root}/skills/writing/vocabulary.md`;
    const b = root + '/skills/writing/vocabulary.md';
    expect(isVocabularyFile(a, b)).toBe(true);
  });

  it('returns true when a path has "./" or ".." segments that resolve to the same file', () => {
    expect(
      isVocabularyFile('./skills/writing/vocabulary.md', 'skills/../skills/writing/vocabulary.md')
    ).toBe(true);
  });

  it('returns true for a ".." normalisation where both paths are anchored under the same absolute root', () => {
    const root = resolve(repoRoot, 'skills/writing');
    const a = `${root}/nested/../vocabulary.md`;
    const b = `${root}/vocabulary.md`;
    expect(isVocabularyFile(a, b)).toBe(true);
  });

  // EXPECTED TO FAIL against the current implementation: it returns true here
  // because of a loose path-suffix fallback (added to satisfy a since-removed
  // mixed relative/absolute test case). A vocabulary.md in a DIFFERENT
  // checkout root must not compare equal to this one just because the
  // trailing path segments match.
  it('returns false for the same relative suffix under two different absolute roots', () => {
    const rootA = resolve(repoRoot, 'skills/writing');
    const rootB = resolve(repoRoot, 'docs/other-checkout/skills/writing');
    expect(isVocabularyFile(`${rootA}/vocabulary.md`, `${rootB}/vocabulary.md`)).toBe(false);
  });

  it('returns false for two different files', () => {
    expect(isVocabularyFile('skills/writing/vocabulary.md', 'skills/writing/other.md')).toBe(false);
    expect(
      isVocabularyFile(
        resolve(repoRoot, 'skills/writing/vocabulary.md'),
        resolve(repoRoot, 'docs/vocabulary.md')
      )
    ).toBe(false);
  });
});

describe('lintProse: finding order', () => {
  it('orders findings by line, then by column within the same line', () => {
    const vocab: VocabularyEntry[] = [
      { avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' },
      { avoid: '—', writeInstead: 'en dash with spaces', note: '', section: 'marks' },
    ];
    // The two same-line findings come from DIFFERENT rules (mark, then
    // vocabulary), with the mark positioned first and the vocabulary word
    // positioned later. If a rule-by-rule scan emits all of one rule's
    // findings before the other's, this is the arrangement that would come
    // out in the wrong order without an explicit column sort.
    const text = [
      '— then utilize it near the end of the line.',
      'nothing to flag on this line.',
      'em dash here — see.',
    ].join('\n') + '\n';
    const findings = lintProse(text, vocab);
    const tuples = findings.map((f) => ({ line: f.line, column: f.column, rule: f.rule }));
    expect(tuples).toEqual([
      { line: 1, column: 1, rule: 'mark' },
      { line: 1, column: 8, rule: 'vocabulary' },
      { line: 3, column: 14, rule: 'mark' },
    ]);
  });
});

describe('lintProse: empty and clean input', () => {
  it('returns an empty array for an empty string', () => {
    expect(lintProse('', [])).toEqual([]);
  });

  it('returns an empty array when there are no violations', () => {
    expect(lintProse('This is a plain, short sentence.\n', [])).toEqual([]);
  });
});
