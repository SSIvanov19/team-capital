/** SERVER ONLY: immutable fixtures for existing team-capital-1 rooms. */
import type { DealDefinition } from './scenario';
const notice = 'Quoted payments are before costs and depend on conditions. Combine your clues.';
const pass = { value: 'pass' as const, label: 'Pass', advertisedPayment: null, description: 'Decline this deal. Your cash does not change.' };

export const LEGACY_DEALS: DealDefinition[] = [
  {
    info: { number: 1, title: 'Choose a supplier',
      description: 'A client needs its finance systems connected. Which supplier should your team use?', notice,
      options: [
        { value: 'A', label: 'Budget supplier', advertisedPayment: 4_000, description: 'A larger quoted payment, with licence clearance still required.' },
        { value: 'B', label: 'Licensed supplier', advertisedPayment: 2_000, description: 'A smaller quoted payment through an established supplier.' }, pass,
      ] },
    clues: {
      accountant: 'Both options have a £1,000 setup cost. The quoted payment is before this cost.',
      analyst: 'Standard licence applications clear 70% of the time. Uncertified applications clear 20% of the time.',
      developer: 'Supplier A needs standard licence clearance. Supplier B already holds the required licence.',
      operations: 'A failed licence application adds a £1,000 recovery charge, on top of the setup cost.',
      coordinator: 'The client pays the quote only after licence clearance. Supplier B’s clearance is already secured.',
    },
    events: [
      { id: 'licence_cleared', label: 'The standard licence cleared', weight: 70, counterfactuals: { A: 3_000, B: 1_000, pass: 0 },
        explanation: 'A received £4,000 and paid the £1,000 setup cost. B received £2,000 and paid the same setup cost. This shared licence outcome applied to every team.' },
      { id: 'licence_failed', label: 'The standard licence failed', weight: 30, counterfactuals: { A: -2_000, B: 1_000, pass: 0 },
        explanation: 'A received no payment and paid £1,000 setup plus £1,000 recovery. B’s existing licence secured its payment, leaving £1,000 after setup.' },
    ],
  },
  {
    info: { number: 2, title: 'Run a client event',
      description: 'Choose between an already booked workshop and a larger premium event whose payment depends on attendance.', notice,
      options: [
        { value: 'A', label: 'Standard workshop', advertisedPayment: 2_500, description: 'Run a smaller workshop for existing bookings.' },
        { value: 'B', label: 'Premium event', advertisedPayment: 4_700, description: 'Run a bigger event whose payment depends on attendance.' }, pass,
      ] },
    clues: {
      accountant: 'Either event costs £700 to run. This cost is paid even if the premium event is cancelled.',
      analyst: 'High attendance has a 40% chance for an in-person event and a 70% chance for a hybrid event.',
      developer: 'The premium package supports in-person attendance only. It cannot use the hybrid format.',
      operations: 'Normal attendance cancels the premium event and adds a £300 cancellation charge.',
      coordinator: 'Existing workshop bookings guarantee A’s £2,500 payment. B gets £4,700 only with high attendance; cancellation pays nothing.',
    },
    events: [
      { id: 'high_attendance', label: 'The in-person event attracted high attendance', weight: 40, counterfactuals: { A: 1_800, B: 4_000, pass: 0 },
        explanation: 'A’s booked workshop earned £2,500 minus £700 costs. High attendance earned B £4,700 minus £700 costs. The premium upside occurred, but it was never guaranteed.' },
      { id: 'normal_attendance', label: 'Attendance stayed at the normal level', weight: 60, counterfactuals: { A: 1_800, B: -1_000, pass: 0 },
        explanation: 'A retained its guaranteed workshop payment, earning £1,800 net. B was cancelled, received no payment and paid £700 running costs plus the £300 cancellation charge.' },
    ],
  },
  {
    info: { number: 3, title: 'Rescue a client’s archive',
      description: 'A client needs an archive converted before a tight deadline. Compare both contracts with passing.', notice,
      options: [
        { value: 'A', label: 'Basic converter', advertisedPayment: 1_500, description: 'Use a basic conversion tool with a larger quoted payment.' },
        { value: 'B', label: 'Specialist converter', advertisedPayment: 1_000, description: 'Use a specialist tool with a smaller quoted payment.' }, pass,
      ] },
    clues: {
      accountant: 'Either converter requires a non-refundable £500 preparation fee.',
      analyst: 'The archive has a 20% chance of being clean, 40% recoverable and 40% unusable.',
      developer: 'A can process only clean archives. B can process clean and recoverable archives.',
      operations: 'An unsuccessful conversion adds an abort charge: £1,500 for A or £1,000 for B.',
      coordinator: 'The client pays the quoted amount only for a successful conversion. A failed conversion earns nothing.',
    },
    events: [
      { id: 'clean_archive', label: 'The archive was clean', weight: 20, counterfactuals: { A: 1_000, B: 500, pass: 0 },
        explanation: 'Both converters succeeded. After the £500 preparation fee, A earned £1,000 and B earned £500. This favourable outcome does not remove the risks that were known before voting.' },
      { id: 'recoverable_archive', label: 'The archive needed specialist recovery', weight: 40, counterfactuals: { A: -2_000, B: 500, pass: 0 },
        explanation: 'A could not process the archive: no payment, £500 preparation and £1,500 abort costs. B recovered it and earned £1,000 minus £500 preparation.' },
      { id: 'unusable_archive', label: 'The archive was unusable', weight: 40, counterfactuals: { A: -2_000, B: -1_500, pass: 0 },
        explanation: 'Neither converter could complete the job. A paid £500 preparation plus £1,500 abort costs. B paid £500 preparation plus £1,000 abort costs. Passing avoided both losses.',
      },
    ],
  },
  {
    info: { number: 4, title: 'Process an invoice batch',
      description: 'A client needs invoices processed by a firm deadline. Choose between automation and a manual service.', notice,
      options: [
        { value: 'A', label: 'Automated processing', advertisedPayment: 5_500, description: 'A larger quoted payment depends on the automated process finishing.' },
        { value: 'B', label: 'Manual processing', advertisedPayment: 3_000, description: 'A smaller quoted payment for a manual service.' }, pass,
      ] },
    clues: {
      accountant: 'Either processing method costs £1,500. This cost is incurred even when the job fails.',
      analyst: 'Automation succeeds with 75% of approved-format batches and 35% of legacy-format batches.',
      developer: 'This client’s batch uses the approved format.',
      operations: 'The manual service will finish by the contractual deadline.',
      coordinator: 'The client pays only when processing finishes by the deadline. Failed automation misses it and receives no payment.',
    },
    events: [
      { id: 'automation_succeeded', label: 'Automation completed before the deadline', weight: 75, counterfactuals: { A: 4_000, B: 1_500, pass: 0 },
        explanation: 'A earned £5,500 minus £1,500 processing costs. B’s guaranteed manual completion earned £3,000 minus the same £1,500 costs.' },
      { id: 'automation_failed', label: 'Automation missed the deadline', weight: 25, counterfactuals: { A: -1_500, B: 1_500, pass: 0 },
        explanation: 'A received no payment and still paid £1,500 processing costs. B finished on time and earned £1,500 net.' },
    ],
  },
  {
    info: { number: 5, title: 'Choose a support contract',
      description: 'Choose a fixed support fee or a larger payment tied to customer usage after launch.', notice,
      options: [
        { value: 'A', label: 'Fixed support contract', advertisedPayment: 2_200, description: 'Receive a quoted fee for providing the agreed support.' },
        { value: 'B', label: 'Performance contract', advertisedPayment: 4_500, description: 'Receive a larger quoted fee only if the usage target is reached.' }, pass,
      ] },
    clues: {
      accountant: 'Either contract costs £1,000 to staff. That cost is incurred whether the usage target is reached or missed.',
      analyst: 'A standard launch reaches the usage target 50% of the time. A promoted launch reaches it 80% of the time.',
      developer: 'The promotional feature needs two more weeks of development.',
      operations: 'The client launches next week. The launch date cannot move.',
      coordinator: 'A pays £2,200 for providing support. B pays £4,500 only when the usage target is reached; otherwise it pays nothing.',
    },
    events: [
      { id: 'usage_target_reached', label: 'The standard launch reached its usage target', weight: 50, counterfactuals: { A: 1_200, B: 3_500, pass: 0 },
        explanation: 'A earned its fixed £2,200 fee minus £1,000 staffing. B earned £4,500 minus £1,000 staffing because the usage target was reached.' },
      { id: 'usage_target_missed', label: 'The standard launch missed its usage target', weight: 50, counterfactuals: { A: 1_200, B: -1_000, pass: 0 },
        explanation: 'A still earned £1,200 after staffing costs. B received no performance payment and paid £1,000 staffing. The 80% promoted-launch forecast did not apply to this deadline.' },
    ],
  },
];

