// Classic experiments shipped with EconLab. Each one is an ordinary experiment
// definition – open it in the editor to see how it is built, or copy and adapt it.

const payment = (o = {}) => ({
  mode: 'all', exchangeRate: 0.1, pointsName: 'points', currencySymbol: '$', participationFee: 5, ...o,
});

export const EXAMPLES = [
  // -------------------------------------------------------------------------
  {
    key: 'public-goods',
    name: 'Public goods game',
    summary: 'Four players repeatedly decide how much of an endowment to put into a shared project.',
    tags: ['groups', 'repeated', 'cooperation'],
    experiment: {
      name: 'Public goods game',
      description: 'Linear voluntary contribution mechanism (Isaac, Walker & Thomas 1984). 4 players, 10 rounds, fixed groups.',
      design: {
        groupSize: 4,
        rounds: 10,
        matching: 'fixed',
        constants: { endowment: 20, mpcr: 0.4 },
        payment: payment({ exchangeRate: 0.05 }),
        finalMessage: 'Thank you for taking part in this study.',
      },
      stages: [
        {
          type: 'info', title: 'Instructions', showIf: 'round == 1',
          body: `Welcome! You are now part of a group of **{{ group.size }} people**. The experiment lasts **{{ num_rounds }} rounds** and you stay in the same group throughout.

In every round each member of your group receives **{{ const.endowment }} points**. You decide how many of them to contribute to a *group project*; the rest you keep.

- Every point in the project is multiplied so that each group member receives **{{ const.mpcr }} points** back for every point contributed by anyone (including you).
- Your earnings in a round = points you kept + {{ const.mpcr }} × total group contributions.

Your points are converted to money at the end of the experiment.`,
        },
        {
          type: 'decision', title: 'Your contribution',
          body: 'Round **{{ round }}** of {{ num_rounds }}. You have **{{ const.endowment }} points**.',
          fields: [{
            name: 'contribution', type: 'integer', min: 0, max: 'const.endowment', default: 0,
            label: 'How many points do you contribute to the group project?', suffix: 'points',
          }],
        },
        {
          type: 'wait', title: 'Please wait', body: 'Waiting for the other group members to decide…',
          compute: [
            { scope: 'group', name: 'total', expr: 'sum(group.players.contribution)' },
            { scope: 'group', name: 'share', expr: 'group.total * const.mpcr' },
            { scope: 'player', name: 'payoff', expr: 'const.endowment - player.contribution + group.share' },
          ],
        },
        {
          type: 'info', title: 'Round results',
          body: `| | Points |
|---|---|
| You contributed | {{ player.contribution }} |
| Group total | {{ group.total }} |
| Your return from the project | {{ group.share }} |
| **Your earnings this round** | **{{ player.payoff }}** |`,
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'dictator',
    name: 'Dictator game',
    summary: 'One player splits an amount with an anonymous recipient. A one-shot measure of altruism.',
    tags: ['pairs', 'one-shot', 'roles'],
    experiment: {
      name: 'Dictator game',
      description: 'Forsythe et al. (1994). Pairs of participants; the Dictator decides alone.',
      design: {
        groupSize: 2,
        rounds: 1,
        roles: ['Dictator', 'Recipient'],
        constants: { endowment: 10 },
        payment: payment({ exchangeRate: 0.5 }),
        finalMessage: 'Thank you for participating!',
      },
      stages: [
        {
          type: 'info', title: 'Instructions',
          body: `You have been randomly paired with another participant, whom you will never meet. One of you is the **Dictator** and the other is the **Recipient**.

The Dictator receives **{{ const.endowment }} points** and decides how many of them to give to the Recipient. The Recipient makes no decision.

You are the **{{ player.role }}**.`,
        },
        {
          type: 'decision', title: 'Your decision', showIf: "player.role == 'Dictator'",
          body: 'You have **{{ const.endowment }} points**.',
          fields: [{
            name: 'give', type: 'integer', min: 0, max: 'const.endowment', default: 0, suffix: 'points',
            label: 'How many points do you give to the Recipient?',
          }],
        },
        {
          type: 'wait', title: 'Please wait', body: 'The Dictator is making a decision…',
          compute: [{
            scope: 'player', name: 'payoff',
            expr: "if(player.role == 'Dictator', const.endowment - roles.Dictator.give, roles.Dictator.give)",
          }],
        },
        {
          type: 'info', title: 'Result',
          body: 'The Dictator gave **{{ roles.Dictator.give }}** of {{ const.endowment }} points to the Recipient.\n\nYou earned **{{ player.payoff }} points**.',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'ultimatum',
    name: 'Ultimatum game',
    summary: 'A proposer offers a split; the responder accepts or rejects. Random re-matching with alternating roles.',
    tags: ['pairs', 'sequential', 'repeated', 'roles'],
    experiment: {
      name: 'Ultimatum game',
      description: 'Güth, Schmittberger & Schwarze (1982). Strangers matching, roles alternate each round.',
      design: {
        groupSize: 2,
        rounds: 5,
        matching: 'random',
        rotateRoles: true,
        roles: ['Proposer', 'Responder'],
        constants: { pie: 100 },
        payment: payment({ mode: 'random_round', exchangeRate: 0.1 }),
        finalMessage: 'One round was randomly selected for payment.',
      },
      stages: [
        {
          type: 'info', title: 'Instructions', showIf: 'round == 1',
          body: `In each of the **{{ num_rounds }} rounds** you are paired with a different participant. In each pair one person is the **Proposer** and the other the **Responder**; roles change between rounds.

The Proposer divides **{{ const.pie }} points** between the two of them. The Responder can **accept** (both get the proposed amounts) or **reject** (both get nothing).

At the end, **one round is selected at random** and you are paid for that round only.`,
        },
        {
          type: 'decision', title: 'Make a proposal', showIf: "player.role == 'Proposer'",
          body: 'Round {{ round }} of {{ num_rounds }}. You are the **Proposer** and divide {{ const.pie }} points.',
          fields: [{
            name: 'offer', type: 'integer', min: 0, max: 'const.pie', default: 50, suffix: 'points',
            label: 'How many points do you offer to the Responder?',
          }],
        },
        { type: 'wait', title: 'Please wait', body: 'The Proposer is making an offer…', compute: [] },
        {
          type: 'decision', title: 'Respond to the offer', showIf: "player.role == 'Responder'",
          body: 'Round {{ round }} of {{ num_rounds }}. The Proposer offers you **{{ roles.Proposer.offer }}** points and keeps **{{ const.pie - roles.Proposer.offer }}**.',
          fields: [{
            name: 'response', type: 'choice', default: null,
            label: 'Do you accept this offer?',
            options: [{ value: 'accept', label: 'Accept' }, { value: 'reject', label: 'Reject' }],
          }],
        },
        {
          type: 'wait', title: 'Please wait', body: 'The Responder is deciding…',
          compute: [
            { scope: 'group', name: 'accepted', expr: "roles.Responder.response == 'accept'" },
            {
              scope: 'player', name: 'payoff',
              expr: "if(group.accepted, if(player.role == 'Proposer', const.pie - roles.Proposer.offer, roles.Proposer.offer), 0)",
            },
          ],
        },
        {
          type: 'info', title: 'Round results',
          body: 'The Proposer offered **{{ roles.Proposer.offer }}** points and the Responder **{{ if(group.accepted, "accepted", "rejected") }}**.\n\nYour earnings this round: **{{ player.payoff }} points**.',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'trust',
    name: 'Trust game (with treatments)',
    summary: 'Sender invests, the amount is multiplied, receiver returns some. Two treatments vary the multiplier.',
    tags: ['pairs', 'sequential', 'treatments'],
    experiment: {
      name: 'Trust game',
      description: 'Berg, Dickhaut & McCabe (1995). Between-subject treatments: multiplier 3 vs 2. Use a multiple of 4 participants for a balanced design.',
      design: {
        groupSize: 2,
        rounds: 1,
        roles: ['Sender', 'Receiver'],
        constants: { endowment: 10, multiplier: 3 },
        treatments: [
          { name: 'Multiplier 3', constants: { multiplier: 3 } },
          { name: 'Multiplier 2', constants: { multiplier: 2 } },
        ],
        payment: payment({ exchangeRate: 0.5 }),
      },
      stages: [
        {
          type: 'info', title: 'Instructions',
          body: `You are the **{{ player.role }}** in a pair.

The **Sender** starts with {{ const.endowment }} points and can send any part of it to the Receiver. The amount sent is **multiplied by {{ const.multiplier }}** on the way. The **Receiver** then decides how many of the received points to send back.`,
        },
        {
          type: 'decision', title: 'How much do you send?', showIf: "player.role == 'Sender'",
          fields: [{
            name: 'sent', type: 'integer', min: 0, max: 'const.endowment', default: 0, suffix: 'points',
            label: 'How many points do you send to the Receiver?',
          }],
        },
        { type: 'wait', title: 'Please wait', body: 'The Sender is deciding…', compute: [] },
        {
          type: 'decision', title: 'How much do you return?', showIf: "player.role == 'Receiver'",
          body: 'The Sender sent **{{ roles.Sender.sent }}** points. After multiplying, you received **{{ const.multiplier * roles.Sender.sent }}** points.',
          fields: [{
            name: 'returned', type: 'integer', min: 0, max: 'const.multiplier * roles.Sender.sent', default: 0, suffix: 'points',
            label: 'How many points do you send back?',
          }],
        },
        {
          type: 'wait', title: 'Please wait', body: 'Waiting for the Receiver…',
          compute: [{
            scope: 'player', name: 'payoff',
            expr: "if(player.role == 'Sender', const.endowment - roles.Sender.sent + roles.Receiver.returned, const.multiplier * roles.Sender.sent - roles.Receiver.returned)",
          }],
        },
        {
          type: 'info', title: 'Result',
          body: 'Sent: **{{ roles.Sender.sent }}**, returned: **{{ roles.Receiver.returned }}**.\n\nYour earnings: **{{ player.payoff }} points**.',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'prisoners-dilemma',
    name: "Repeated prisoner's dilemma",
    summary: 'Two players choose Cooperate or Defect over several rounds with the same partner.',
    tags: ['pairs', 'repeated', 'cooperation'],
    experiment: {
      name: "Repeated prisoner's dilemma",
      description: 'Finitely repeated PD with fixed partners. Payoff matrix is stored in constants so it is easy to change.',
      design: {
        groupSize: 2,
        rounds: 8,
        matching: 'fixed',
        constants: { T: 5, R: 3, P: 1, S: 0 },
        payment: payment({ exchangeRate: 0.05 }),
      },
      stages: [
        {
          type: 'info', title: 'Instructions', showIf: 'round == 1',
          body: `You play **{{ num_rounds }} rounds** with the same partner. In each round you both choose simultaneously between **Cooperate** and **Defect**.

| You \\ Other | Cooperate | Defect |
|---|---|---|
| **Cooperate** | {{ const.R }}, {{ const.R }} | {{ const.S }}, {{ const.T }} |
| **Defect** | {{ const.T }}, {{ const.S }} | {{ const.P }}, {{ const.P }} |

(first number = your points, second = your partner's points)`,
        },
        {
          type: 'decision', title: 'Your choice', body: 'Round {{ round }} of {{ num_rounds }}.',
          fields: [{
            name: 'action', type: 'choice', default: null, label: 'What do you choose?',
            options: [{ value: 'C', label: 'Cooperate' }, { value: 'D', label: 'Defect' }],
          }],
        },
        {
          type: 'wait', title: 'Please wait', body: 'Waiting for your partner…',
          compute: [
            { scope: 'player', name: 'other_action', expr: 'others.action[0]' },
            {
              scope: 'player', name: 'payoff',
              expr: "if(player.action == 'C', if(player.other_action == 'C', const.R, const.S), if(player.other_action == 'C', const.T, const.P))",
            },
          ],
        },
        {
          type: 'info', title: 'Round results',
          body: 'You chose **{{ if(player.action == "C", "Cooperate", "Defect") }}**, your partner chose **{{ if(player.other_action == "C", "Cooperate", "Defect") }}**.\n\nYou earned **{{ player.payoff }} points**.',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'beauty-contest',
    name: 'Beauty contest (guess 2/3 of the average)',
    summary: 'Groups of four guess a number; the closest to two thirds of the average wins. Strangers matching.',
    tags: ['groups', 'repeated', 'strategic thinking'],
    experiment: {
      name: 'Beauty contest',
      description: 'Nagel (1995). Prize is split among ties. Random re-matching each round.',
      design: {
        groupSize: 4,
        rounds: 3,
        matching: 'random',
        constants: { prize: 100, factor: 0.6667 },
        payment: payment({ exchangeRate: 0.05 }),
      },
      stages: [
        {
          type: 'info', title: 'Instructions', showIf: 'round == 1',
          body: `Each of the {{ group.size }} players in a group chooses a number between **0 and 100**. The winner is the player whose number is **closest to 2/3 of the group average**. The winner receives **{{ const.prize }} points** (shared equally in case of ties); everybody else receives 0.

There are {{ num_rounds }} rounds and you are matched with new people each time.`,
        },
        {
          type: 'decision', title: 'Your guess', body: 'Round {{ round }} of {{ num_rounds }}.',
          timeoutSeconds: 90,
          fields: [{ name: 'guess', type: 'number', min: 0, max: 100, default: 50, label: 'Which number do you choose (0–100)?', step: 0.01 }],
        },
        {
          type: 'wait', title: 'Please wait', body: 'Waiting for the other players…',
          compute: [
            { scope: 'group', name: 'average', expr: 'mean(group.players.guess)' },
            { scope: 'group', name: 'target', expr: 'group.average * const.factor' },
            { scope: 'player', name: 'distance', expr: 'abs(player.guess - group.target)' },
            {
              scope: 'player', name: 'payoff',
              expr: 'if(player.distance == min(group.players.distance), const.prize / count(group.players.distance, min(group.players.distance)), 0)',
            },
          ],
        },
        {
          type: 'info', title: 'Round results',
          body: 'The average guess was **{{ fmt(group.average, 2) }}**, so the target was **{{ fmt(group.target, 2) }}**.\n\nYour guess: {{ player.guess }}. You earned **{{ fmt(player.payoff, 2) }} points**.',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'first-price-auction',
    name: 'First-price sealed-bid auction',
    summary: 'Private values are drawn at random each round; highest bid wins and pays its bid.',
    tags: ['groups', 'repeated', 'markets', 'randomisation'],
    experiment: {
      name: 'First-price sealed-bid auction',
      description: 'Demonstrates random draws (randint, random) inside a wait page that runs at the start of every round.',
      design: {
        groupSize: 4,
        rounds: 5,
        matching: 'random',
        payment: payment({ mode: 'random_round', exchangeRate: 0.1 }),
      },
      stages: [
        {
          type: 'wait', title: 'New round', body: 'Drawing your private value…',
          compute: [{ scope: 'player', name: 'value', expr: 'randint(10, 100)' }],
        },
        {
          type: 'decision', title: 'Place your bid',
          body: `Round **{{ round }}** of {{ num_rounds }}. Four bidders compete for one item. Your private value for the item is **{{ player.value }} points**.

The highest bid wins and pays **its own bid**; the winner earns value − bid. Everyone else earns 0.`,
          fields: [{ name: 'bid', type: 'integer', min: 0, max: 100, default: 0, label: 'Your bid', suffix: 'points' }],
        },
        {
          type: 'wait', title: 'Please wait', body: 'Waiting for the other bidders…',
          compute: [
            { scope: 'player', name: 'score', expr: 'player.bid + random() * 0.001' },
            { scope: 'player', name: 'won', expr: 'player.score == max(group.players.score)' },
            { scope: 'player', name: 'payoff', expr: 'if(player.won, player.value - player.bid, 0)' },
          ],
        },
        {
          type: 'info', title: 'Auction result',
          body: '{{ if(player.won, "You **won** the auction!", "You did not win the auction.") }}\n\nHighest bid: **{{ max(group.players.bid) }}**. Your bid: {{ player.bid }}. Your value: {{ player.value }}.\n\nEarnings: **{{ player.payoff }} points**.',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'risk-eckel-grossman',
    name: 'Risk preference (Eckel–Grossman)',
    summary: 'Individual task: choose one of five 50/50 gambles. Shows random outcomes and individual payoffs.',
    tags: ['individual', 'risk', 'randomisation'],
    experiment: {
      name: 'Risk preference elicitation',
      description: 'Eckel & Grossman (2002). Single-player stages need no waiting for others.',
      design: {
        groupSize: 1,
        rounds: 1,
        payment: payment({ exchangeRate: 0.25, participationFee: 3 }),
        finalMessage: 'Thank you! Your payment will be arranged by the experimenter.',
      },
      stages: [
        {
          type: 'decision', title: 'Choose a gamble',
          body: `Choose **one** of the five gambles below. Each pays one of two amounts with equal (50%) probability, determined by a virtual coin flip.

| Gamble | If heads | If tails |
|---|---|---|
| 1 | 16 | 16 |
| 2 | 24 | 12 |
| 3 | 32 | 8 |
| 4 | 40 | 4 |
| 5 | 48 | 0 |`,
          fields: [{
            name: 'gamble', type: 'choice', default: null, label: 'Which gamble do you choose?', layout: 'radio',
            options: [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `Gamble ${n}` })),
          }],
          compute: [
            { scope: 'player', name: 'heads', expr: 'bernoulli(0.5)' },
            { scope: 'player', name: 'payoff', expr: 'if(player.heads, [16, 24, 32, 40, 48][player.gamble - 1], [16, 12, 8, 4, 0][player.gamble - 1])' },
          ],
        },
        {
          type: 'info', title: 'Outcome',
          body: 'The coin landed **{{ if(player.heads, "heads", "tails") }}**. You earned **{{ player.payoff }} points**.',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  {
    key: 'survey',
    name: 'Consent + questionnaire',
    summary: 'A short survey with consent checkbox, number, choice, Likert and free-text fields.',
    tags: ['individual', 'survey'],
    experiment: {
      name: 'Consent and questionnaire',
      description: 'Shows every field type. Combine its stages with any game by copying them across.',
      design: {
        groupSize: 1,
        rounds: 1,
        payment: payment({ participationFee: 2 }),
        finalMessage: 'Thank you for completing the questionnaire.',
      },
      stages: [
        {
          type: 'decision', title: 'Consent',
          body: 'This study is part of academic research. Your answers are anonymous and you may stop at any time.',
          fields: [{ name: 'consent', type: 'checkbox', required: true, label: 'I have read the information above and agree to take part.' }],
          buttonLabel: 'Start',
        },
        {
          type: 'decision', title: 'About you',
          fields: [
            { name: 'age', type: 'integer', min: 18, max: 100, label: 'How old are you?', suffix: 'years' },
            {
              name: 'gender', type: 'choice', layout: 'dropdown', label: 'Gender',
              options: [{ value: 'f', label: 'Female' }, { value: 'm', label: 'Male' }, { value: 'x', label: 'Non-binary / other' }, { value: 'na', label: 'Prefer not to say' }],
            },
            {
              name: 'trust', type: 'likert', min: 1, max: 7, label: 'Generally speaking, most people can be trusted.',
              minLabel: 'Strongly disagree', maxLabel: 'Strongly agree',
            },
            { name: 'patience', type: 'slider', min: 0, max: 10, step: 1, default: 5, label: 'How patient are you in general?', minLabel: 'Not at all', maxLabel: 'Very' },
            { name: 'comments', type: 'textarea', required: false, label: 'Any comments?' },
          ],
        },
      ],
    },
  },
];

export function exampleList() {
  return EXAMPLES.map(({ key, name, summary, tags }) => ({ key, name, summary, tags }));
}

export function getExample(key) {
  const e = EXAMPLES.find((x) => x.key === key);
  return e ? structuredClone(e.experiment) : null;
}

export function blankExperiment() {
  return {
    name: 'Untitled experiment',
    description: '',
    design: {
      groupSize: 1,
      rounds: 1,
      matching: 'fixed',
      constants: {},
      payment: payment({ participationFee: 0 }),
    },
    stages: [
      {
        type: 'info', title: 'Welcome',
        body: 'Welcome to the experiment. Edit this page, add decision pages and set payoffs.\n\nUse {{ expressions }} to show values, e.g. you are in round {{ round }}.',
      },
    ],
  };
}
