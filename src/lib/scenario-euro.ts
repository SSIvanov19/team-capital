/** SERVER ONLY: approved dramatic scenarios for team-capital-2. */
import type { DealDefinition } from './scenario';
const notice = 'Quoted payments are before costs and depend on conditions. Combine your clues.';
const pass = { value: 'pass' as const, label: 'Pass', advertisedPayment: null, description: 'Decline this job. Your cash does not change.' };
export const EURO_DEALS: DealDefinition[] = [
  {
    info: { number: 1, title: 'The midnight discount',
      description: 'Your team is about to finish for the night when a client calls. Their new office opens at 09:00, but the staff still need software access. They’ll pay €5,000 to get everyone online. It’s 23:00—and one supplier’s heavily advertised discount expires at midnight.', notice,
      options: [
        { value: 'A', label: 'Discounted bundle', advertisedPayment: 5000, description: 'Buy the discounted licence bundle.' },
        { value: 'B', label: 'Only the licences needed', advertisedPayment: 5000, description: 'Buy licences individually.' }, pass,
      ] },
    clues: {
      accountant: 'A advertises €4 per licence. B charges €12 per licence.',
      analyst: 'The client needs exactly 200 new licences.',
      developer: 'Both packages work with the client’s system.',
      operations: 'Both suppliers deliver on time. Unused licences cannot be refunded or resold.',
      coordinator: 'A requires a minimum order of 1,000 licences. B has no minimum order.',
    },
    events: [{ id: 'licences_delivered', label: 'Both suppliers deliver before the office opens', weight: 100,
      counterfactuals: { A: 1000, B: 2600, pass: 0 },
      explanation: 'A’s minimum order costs 1,000 × €4 = €4,000, leaving €1,000 from the €5,000 payment. B buys only 200 × €12 = €2,400, leaving €2,600. A’s lower unit price does not make it the cheaper order.' }],
  },
  {
    info: { number: 2, title: 'The event goes viral',
      description: 'Tomorrow’s product reveal was supposed to be a modest online event. Then a famous influencer shares the registration link. The client’s marketing team is celebrating, but the event manager is calling you: they still haven’t booked the platform. €4,000 is on offer, and nobody knows how big the audience will be.', notice,
      options: [
        { value: 'A', label: 'Large platform', advertisedPayment: 4000, description: 'Book the larger event platform.' },
        { value: 'B', label: 'Cheaper platform', advertisedPayment: 4000, description: 'Book the lower-cost event platform.' }, pass,
      ] },
    clues: {
      accountant: 'A costs €2,500. B costs €1,000. These costs apply even if the event fails.',
      analyst: 'There is a 60% chance of normal turnout and a 40% chance of viral turnout.',
      developer: 'A holds 1,000 people. B holds only 300 and cannot upgrade.',
      operations: 'Normal turnout means 200 people. Viral turnout means 800.',
      coordinator: 'The client pays €4,000 only if every registered guest gets in. Otherwise, payment is €0.',
    },
    events: [
      { id: 'normal_turnout', label: 'Normal turnout: 200 guests register', weight: 60,
        counterfactuals: { A: 1500, B: 3000, pass: 0 },
        explanation: 'Both platforms admit all 200 guests and earn the €4,000 fee. A pays €2,500, leaving €1,500; B pays €1,000, leaving €3,000. B’s larger profit came with a known risk of exceeding its capacity.' },
      { id: 'viral_turnout', label: 'Viral turnout: 800 guests register', weight: 40,
        counterfactuals: { A: 1500, B: -1000, pass: 0 },
        explanation: 'A admits all 800 guests and earns €4,000 minus €2,500 costs: €1,500. B’s 300-person limit prevents it admitting everyone, so it earns no fee and loses its €1,000 cost. There is no partial payment.' },
    ],
  },
  {
    info: { number: 3, title: 'The payroll deadline',
      description: 'It’s payday, and your client has left payroll dangerously late. The bank’s final processing window is approaching, and employees are already asking when their wages will arrive. The finance director offers your team €5,000 to get it through. Two suppliers are available, both advertising backup systems.', notice,
      options: [
        { value: 'A', label: 'Cheaper local servers', advertisedPayment: 5000, description: 'Use the cheaper supplier and its backup.' },
        { value: 'B', label: 'Independent power', advertisedPayment: 5000, description: 'Use the independently powered backup.' }, pass,
      ] },
    clues: {
      accountant: 'A costs €1,500. B costs €3,000. Both costs are non-refundable.',
      analyst: 'There is a 30% chance of a local power cut during processing. Otherwise, power stays on.',
      developer: 'A’s main server and backup share the same power supply.',
      operations: 'B’s backup has independent power and keeps running during a local power cut.',
      coordinator: 'Uninterrupted processing meets the deadline and earns €5,000. An interruption misses it and earns nothing.',
    },
    events: [
      { id: 'power_stays_on', label: 'Power stays on through the bank’s processing window', weight: 70,
        counterfactuals: { A: 3500, B: 2000, pass: 0 },
        explanation: 'Both suppliers finish uninterrupted and earn €5,000. A pays €1,500, leaving €3,500; B pays €3,000, leaving €2,000. A’s backup still shared its main server’s power supply; this time, that risk did not occur.' },
      { id: 'local_power_cut', label: 'A local power cut interrupts processing', weight: 30,
        counterfactuals: { A: -1500, B: 2000, pass: 0 },
        explanation: 'A’s main server and backup both lose power. It misses the deadline, earns nothing and loses €1,500. B keeps running on independent power and earns €5,000 minus €3,000 costs: €2,000.' },
    ],
  },
  {
    info: { number: 4, title: '€6,000 before breakfast',
      description: 'It’s Friday afternoon. A company director has promised investors a working dashboard at 09:00 Saturday—but it hasn’t been built. Now they’re asking your team to work overnight: €6,000 for the full dashboard or €3,500 for a quick prototype. “I’ve already told them it’ll be ready. Can you make this happen?”', notice,
      options: [
        { value: 'A', label: 'Full dashboard', advertisedPayment: 6000, description: 'Accept the full dashboard job.' },
        { value: 'B', label: 'Quick prototype', advertisedPayment: 3500, description: 'Accept the smaller prototype job.' }, pass,
      ] },
    clues: {
      accountant: 'Accepting A commits €1,500 in non-refundable costs. B commits €800.',
      analyst: 'A takes four hours to build. B takes one hour.',
      developer: 'Both options need the client’s approved data export before work can begin.',
      operations: 'The export arrives at 09:00 the following Monday. It cannot arrive earlier.',
      coordinator: 'The Saturday deadline is fixed. Late or unfinished work earns no payment.',
    },
    events: [{ id: 'data_after_deadline', label: 'Saturday’s deadline passes before the data arrives', weight: 100,
      counterfactuals: { A: -1500, B: -800, pass: 0 },
      explanation: 'Neither option can start until the data arrives on the following Monday, after Saturday’s fixed deadline. A loses its committed €1,500 and B loses €800; neither earns a fee. Passing avoids both losses. A shorter build time cannot solve a missing prerequisite.' }],
  },
  {
    info: { number: 5, title: 'The ‘fully insured’ celebrity shoot',
      description: 'A celebrity’s agent needs a campaign filmed tomorrow, and your team has been offered the booking. The studio shoot pays €6,000; a remote version pays €3,500. The agent keeps pushing the studio: “It’s fully insured. We’ll be fine.” You have the contract details, but little time to compare them.', notice,
      options: [
        { value: 'A', label: 'Insured studio', advertisedPayment: 6000, description: 'Book the studio shoot with insurance.' },
        { value: 'B', label: 'Flexible remote shoot', advertisedPayment: 3500, description: 'Book the remote version.' }, pass,
      ] },
    clues: {
      accountant: 'A costs €2,000, including insurance. B costs €1,500. Both are paid upfront.',
      analyst: 'There is a 70% chance the shoot goes ahead and a 30% chance the client cancels.',
      developer: 'Both approaches can meet the client’s brief if the shoot goes ahead.',
      operations: 'If the client cancels, B’s supplier refunds all €1,500 costs. A’s supplier refunds nothing.',
      coordinator: 'Insurance covers equipment damage only. If the client cancels, neither option receives its client fee.',
    },
    events: [
      { id: 'shoot_goes_ahead', label: 'The celebrity shoot goes ahead', weight: 70,
        counterfactuals: { A: 4000, B: 2000, pass: 0 },
        explanation: 'A earns €6,000 minus €2,000 costs: €4,000. B earns €3,500 minus €1,500 costs: €2,000. There is no insurance payout. The studio’s larger profit came with a known cancellation risk.' },
      { id: 'client_cancels', label: 'The client cancels the shoot', weight: 30,
        counterfactuals: { A: -2000, B: 0, pass: 0 },
        explanation: 'Neither option earns a client fee. A loses €2,000: its insurance covers equipment damage, not cancellation. B’s supplier refunds the full €1,500 upfront cost, leaving a net change of €0. No client deposit or fee is retained.' },
    ],
  },
];
