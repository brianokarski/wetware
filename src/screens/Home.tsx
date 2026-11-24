import { Mono, Table } from "../components/primitives";
import { dayKey, type Habit } from "../data";

/** Milestone 1 placeholder for the month grid: proves habits.yaml loads. */
export function Home({ habits, today }: { habits: Habit[]; today: Date }) {
  const month = today.toLocaleDateString("en-US", { month: "long" });
  const active = habits.filter((h) => !h.archived);

  return (
    <>
      <h1 className="display">
        {month} {today.getDate()}
      </h1>
      <Table label={`Habits ${String(active.length).padStart(2, "0")}`}>
        {active.map((habit) => (
          <div className="row row-habit" key={habit.id}>
            <div>{habit.name}</div>
            <Mono>
              {habit.type}
              {habit.unit ? ` / ${habit.unit}` : ""}
              {habit.goal ? ` / ${habit.goal}` : ""}
            </Mono>
            <Mono>{habit.source}</Mono>
            <Mono muted>{dayKey(habit)}</Mono>
          </div>
        ))}
      </Table>
      <Mono muted>The month grid arrives in Milestone 2.</Mono>
    </>
  );
}
