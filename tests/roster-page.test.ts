import assert from "node:assert/strict";
import test from "node:test";

import {
  extractRosterPeople,
  extractRosterPeopleFromText,
} from "../lib/discovery/connectors/roster-page";

test("extracts names, rank, country, and recognition from an IOI-style table", () => {
  const people = extractRosterPeople(
    `
      <html><body><h1>IOI 2025</h1><table>
        <tr><th>Rank</th><th>Contestant</th><th>Country</th><th>Award</th></tr>
        <tr>
          <td>1</td>
          <td><a href="/people/1001">Hengxi Liu</a></td>
          <td><a href="/countries/CHN">China</a></td>
          <td>591.23 Gold</td>
        </tr>
        <tr>
          <td>2</td>
          <td><a href="/people/1002">Mingyu Woo</a></td>
          <td><a href="/countries/KOR">Republic of Korea</a></td>
          <td>574.78 Gold</td>
        </tr>
      </table></body></html>
    `,
    "https://stats.ioinformatics.org/results/2025",
  );

  assert.deepEqual(
    people.map((person) => ({
      affiliation: person.affiliation,
      name: person.name,
      profileUrl: person.profileUrl,
      rank: person.rank,
      recognition: person.recognition?.toLocaleLowerCase("en-US"),
    })),
    [
      {
        affiliation: "China",
        name: "Hengxi Liu",
        profileUrl: "https://stats.ioinformatics.org/people/1001",
        rank: 1,
        recognition: "gold",
      },
      {
        affiliation: "Republic of Korea",
        name: "Mingyu Woo",
        profileUrl: "https://stats.ioinformatics.org/people/1002",
        rank: 2,
        recognition: "gold",
      },
    ],
  );
});

test("does not treat navigation links as roster people", () => {
  const people = extractRosterPeople(
    `<nav><a href="/people/search">People Search</a></nav>`,
    "https://example.com/results",
  );

  assert.deepEqual(people, []);
});

test("extracts IOI-style roster rows from Exa cached markdown", () => {
  const people = extractRosterPeopleFromText(
    `
| Rank | Contestant | Country | Scores | Award |
| --- | --- | --- | --- | --- |
| 1 | [Hengxi Liu](/people/1001) | China | 591.23 | Gold |
| 2 | [Mingyu Woo](/people/1002) | Republic of Korea | 574.78 | Gold |
    `,
    "https://stats.ioinformatics.org/results/2025",
  );

  assert.deepEqual(
    people.map((person) => ({
      affiliation: person.affiliation,
      name: person.name,
      profileUrl: person.profileUrl,
      rank: person.rank,
      recognition: person.recognition?.toLocaleLowerCase("en-US"),
    })),
    [
      {
        affiliation: "China",
        name: "Hengxi Liu",
        profileUrl: "https://stats.ioinformatics.org/people/1001",
        rank: 1,
        recognition: "gold",
      },
      {
        affiliation: "Republic of Korea",
        name: "Mingyu Woo",
        profileUrl: "https://stats.ioinformatics.org/people/1002",
        rank: 2,
        recognition: "gold",
      },
    ],
  );
});

test("cached markdown requires a labeled person column", () => {
  const people = extractRosterPeopleFromText(
    `| Label | Value |\n| --- | --- |\n| Winner | Results Page |`,
    "https://example.com/results",
  );

  assert.deepEqual(people, []);
});
