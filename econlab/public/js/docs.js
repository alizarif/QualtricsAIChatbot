// In-app documentation. Prose is Markdown; the function reference is generated
// from the same table the engine uses, so it can never go out of date.

import { h, mount } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { FUNCTIONS } from '/shared/expr.js';

const fnTable = () => {
  const rows = [['if(cond, a, b)', 'a if cond is true, otherwise b (only the chosen branch is evaluated)'],
    ...Object.entries(FUNCTIONS).map(([n, f]) => [f[2].split(' — ')[0], f[2].includes(' — ') ? f[2].split(' — ').slice(1).join(' — ') : ''])];
  return `| Function | What it does |\n|---|---|\n${rows.map(([a, b]) => `| \`${a}\` | ${b} |`).join('\n')}`;
};

const SECTIONS = [
  ['start', 'Quick start', () => `
EconLab lets you **design** an experiment in the browser, **run** it with participants on their own devices, and **export** the data and payments. It works like oTree, without writing code: the logic of your game is described with stages and short formulas.

1. **Create an experiment** on the home page (blank, or start from a classic such as the public goods game).
2. In **Design**, set players per group, rounds, roles, constants (parameters), treatments and payment.
3. In **Stages**, build what participants see: information pages, decision pages with questions, and *wait & compute* pages that synchronise a group and calculate payoffs.
4. Press **Quick test with bots** to run a complete session with simulated participants, then check the Data tab.
5. Press **Run session**, share the links (or one shared link), press **Start**, and watch the **Monitor**.
6. Export **data** and **payments** as CSV.`],

  ['concepts', 'Concepts', () => `
| Term | Meaning |
|---|---|
| **Experiment** | The design: settings plus an ordered list of stages. Editing it never changes sessions that already ran. |
| **Session** | One run of an experiment with a set of participants. Every session keeps a frozen copy of the design. |
| **Participant** | A person in a session, identified by a personal link (a long random code). |
| **Stage** | One page in the sequence: information, decision, or wait & compute. |
| **Round** | One pass through all stages. With 10 rounds every stage repeats 10 times. |
| **Group** | A set of participants who interact. Players per group = 1 makes an individual experiment. |
| **Role** | A position inside a group such as Proposer / Responder, fixed or rotating between rounds. |
| **Treatment** | A variant of the experiment with different constants. Whole groups are randomly assigned in balanced blocks. |
| **Constants** | Named parameters (endowment, multiplier, …) used as \`const.name\`. |

**Synchronisation.** At the start of every round all members of a group wait for each other automatically. Within a round, a *wait & compute* page holds everyone until the whole group (or session) has arrived, then runs its calculations once.`],

  ['stages', 'Stages', () => `
### Information page
Text only (Markdown). Use it for instructions and for showing results. Anything in double braces is replaced by a value: \`You earned {{ player.payoff }} points\`.

### Decision page
Questions participants answer. Field types: whole number, decimal, slider, multiple choice (radio or dropdown), Likert scale, checkbox, short and long text.
- **Minimum / Maximum / Default** accept numbers *or formulas*, e.g. a maximum of \`const.endowment\` or \`3 * roles.Sender.sent\`.
- **Default** is only used if the page times out or you advance a participant. Number boxes are not pre-filled, so defaults cannot anchor answers.
- **Answer checks** are rules that must be true before the page is accepted, with a message otherwise, e.g. \`player.q1 == 4\` → "Please re-read the instructions."

### Wait & compute page
Pauses every participant until all members of the group (or the whole session) have arrived. Then its **calculations** run once. This is where payoffs are computed, because all answers of the round are available.

### Calculations
Rows of the form *scope · name = formula*, run **top to bottom**.
- **player** rows run once for every player of the group, each with their own \`player\`.
- **group** rows run once per group and store the value in \`group.name\`.
- **session** rows (only on pages that wait for the whole session) store \`session.name\`.

Set \`player.payoff\` to award points. On information and decision pages only *player* rows are allowed and they run when the participant continues, which suits random draws and individual tasks.

### Display options
- **Show only if** hides a page for some players, e.g. \`player.role == 'Proposer'\`, or \`round == 1\` for instructions that appear once.
- **Time limit** submits the page automatically with default values when the time is up.`],

  ['variables', 'Variables', () => `
| You write | Meaning |
|---|---|
| \`player.contribution\` | This player's answer or computed variable in the **current** round |
| \`player.payoff\` | Points earned this round (0 until set) |
| \`player.role\`, \`player.id_in_group\` | Role name and position in the group |
| \`group.total\` | A group variable set by a *group* calculation |
| \`group.players\` | List of all players in the group. \`group.players.contribution\` is the list of their contributions |
| \`others\` | List of the *other* players: \`mean(others.contribution)\` |
| \`roles.Proposer.offer\` | The \`offer\` of the player whose role is Proposer |
| \`const.endowment\` | A constant (treatment values override the defaults) |
| \`session.price\` | A session variable |
| \`round\`, \`num_rounds\`, \`treatment\` | Where you are in the experiment |
| \`prev.payoff\` | This player's value in the previous round (empty in round 1) |
| \`history.contribution\` | List of this player's values in all earlier rounds |
| \`participant.payoff\` | Cumulative points so far |
| \`all_players\` | Everyone in the session this round (for session-wide calculations) |

A name that has not been set yet is *empty (null)*. Doing arithmetic on it is an error, which is reported under **Problems** in the session. The editor warns you in advance when you use a variable before it is collected.`],

  ['expressions', 'Formulas', () => `
Formulas use a small, safe language (it can never run arbitrary code).

\`\`\`
const.endowment - player.contribution + const.mpcr * sum(group.players.contribution)
if(player.role == 'Proposer', 100 - player.offer, player.offer)
abs(player.guess - 2/3 * mean(group.players.guess))
player.score == max(group.players.score) and round > 1
\`\`\`

**Operators:** \`+ - * / // % ^\` (power; \`**\` also works), comparisons \`== != < <= > >=\`, logic \`and or not\` (or \`&& || !\`), \`x in [1, 2]\`, conditional \`cond ? a : b\`, lists \`[1, 2, 3]\`, indexing \`list[0]\`, \`list[-1]\`. Text uses quotes: \`'accept'\`. Numbers and text join with \`+\`.

**Lists.** A property of a list of players is a list: \`group.players.contribution\`. Combine with \`sum\`, \`mean\`, \`max\`, \`count\`, …

${fnTable()}

Floating point noise is cleaned automatically (\`0.1 + 0.2\` is \`0.3\`). Use \`round(x, 2)\` or \`fmt(x, 2)\` for display.`],

  ['examples', 'Worked examples', () => `
### Public goods game
Constants \`endowment = 20\`, \`mpcr = 0.4\`. Decision field \`contribution\` (0 to \`const.endowment\`). Then a wait page with:

\`\`\`
group  total   = sum(group.players.contribution)
group  share   = group.total * const.mpcr
player payoff  = const.endowment - player.contribution + group.share
\`\`\`

### Ultimatum game
Roles \`Proposer, Responder\`. Page 1 (only if \`player.role == 'Proposer'\`): field \`offer\`. Wait page. Page 2 (only Responder): field \`response\`, text "Offer: {{ roles.Proposer.offer }}". Wait page with:

\`\`\`
group  accepted = roles.Responder.response == 'accept'
player payoff   = if(group.accepted, if(player.role == 'Proposer', 100 - roles.Proposer.offer, roles.Proposer.offer), 0)
\`\`\`

### Random draws
A wait page at the start of the round with \`player value = randint(10, 100)\` gives every player a private value that later pages can show with \`{{ player.value }}\`.`],

  ['running', 'Running a session', () => `
- **Personal links** (one per participant, in the Monitor) are best for the lab: open one per computer. The **shared link** gives the next free seat to whoever opens it, which suits online recruitment. Extra link parameters such as \`?PROLIFIC_PID=abc\` are stored as the participant's ID.
- **Manual start**: participants see a waiting room until you press *Start session*. With **immediate start** they begin on arrival; groups still wait until all members are present.
- **Monitor** shows each participant's status and position. *Advance* submits default values for a participant who dropped out so that the rest of the group can continue (flagged in the data as auto-filled).
- **Time limits** keep sessions moving: the server submits defaults when time is up, even if the participant closed the page.
- **Bots** play randomly so you can test a whole design. Give a session some bots to try a seat yourself.
- Everything is saved continuously; restarting the server keeps all sessions. Participants who reload their page return to where they were.
- Use **Quick test with bots** before every real session and read the **Problems** tab.`],

  ['data', 'Data & payments', () => `
**Data CSV**: one row per participant and round with: session, participant code/id/label, treatment, round, group, id_in_group, role, every question and computed player variable, \`payoff\`, \`group_*\` and \`session_*\` variables, \`round_is_paid\`, and \`auto_filled_stages\`. Booleans are exported as 1/0. Text cells that start with = + - @ get a leading apostrophe so spreadsheets do not execute them.

**Page times CSV**: start, end and seconds for every page of every participant.

**Payments CSV**: points, exchange rate, earnings, participation fee and total per participant. Depending on the setting, all rounds, one random round (chosen at the start of the session and stored), or the last round are paid.

**Everything (JSON)** contains the frozen design, the raw participants and all tables: a complete record for replication.`],

  ['hosting', 'Hosting', () => `
\`\`\`
cd econlab
node server/index.js                       # http://localhost:3000, no dependencies to install

# for a lab network or the internet:
ADMIN_PASSWORD='a-long-password' HOST=0.0.0.0 PORT=3000 node server/index.js
\`\`\`

| Variable | Default | Purpose |
|---|---|---|
| \`PORT\` | 3000 | Port to listen on |
| \`HOST\` | 127.0.0.1 | Use 0.0.0.0 to accept connections from other machines |
| \`DATA_DIR\` | ./data | Where \`db.json\` lives (with a rolling \`db.json.bak\`) |
| \`ADMIN_PASSWORD\` | none | Protects the researcher interface. Required when HOST is not local |
| \`TRUST_PROXY\` | off | Set to 1 behind a reverse proxy so login rate limits use the real client address |

For internet use put the server behind an HTTPS reverse proxy (Caddy, nginx). Participants only need the participant link; they can never see the researcher interface.

**Qualtrics, Prolific, MTurk.** Embed the shared link in an iframe or open it in a new window. Set **Redirect after finishing** in Design → Messages to send participants back to your survey or completion URL.`],

  ['otree', 'Coming from oTree', () => `
| oTree | EconLab |
|---|---|
| \`C\` constants | Design → Constants (\`const.name\`) |
| \`session_config\` treatments / \`creating_session\` | Design → Treatments |
| Player / Group / Subsession fields | Questions and calculation variables (\`player.x\`, \`group.x\`, \`session.x\`) |
| Page with \`form_fields\` | Decision page |
| \`is_displayed\` | Show only if |
| \`error_message\` | Answer checks |
| \`timeout_seconds\` | Time limit |
| \`WaitPage\` + \`after_all_players_arrive\` | Wait & compute (calculations) |
| \`wait_for_all_groups\` | Wait for everyone in the session |
| \`group_randomly\`, \`group_by_arrival_time\` | Matching: partners / strangers |
| \`player.payoff\`, \`participant.payoff\` | \`player.payoff\`; payments tab |
| \`real_world_currency_per_point\`, \`participation_fee\` | Design → Payment |
| bots | Quick test with bots |
| room links | Shared join link |

Differences: logic is declarative (formulas) rather than Python; there is no custom HTML/JavaScript per page; Python \`live\` pages and chat are not available.`],
];

export async function renderDocs(host) {
  const want = (location.hash.match(/^#\/docs\/(\w+)/) ?? [])[1];
  const nav = h('nav', { 'aria-label': 'Documentation sections' }, SECTIONS.map(([id, title]) => h('a', {
    href: `#/docs/${id}`,
    onclick: (e) => { e.preventDefault(); history.replaceState(null, '', `#/docs/${id}`); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); },
  }, title)));
  mount(host, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Documentation')),
    h('div', { class: 'docs' }, nav,
      h('div', null, SECTIONS.map(([id, title, body]) => h('section', { id }, h('h2', null, title), h('div', { class: 'md', html: renderMarkdown(body()) })))))));
  if (want) requestAnimationFrame(() => document.getElementById(want)?.scrollIntoView());
  return {};
}
