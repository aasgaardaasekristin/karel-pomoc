import { AlertTriangle } from "lucide-react";

const items = [
  "Neslibovat dostupnost, kterou nemůžeš garantovat",
  "Nepřebírat odpovědnost za život druhé osoby",
  "Neřešit krizi sama – vždy odkázat na krizové služby",
  "Nevypustit nabídku krizových linek (116 123, 116 111, 158)",
  "Nezkracovat profesionální hranice",
  "Nepokoušet se o diagnostiku na základě otisku",
  "Neobcházet klientovo odmítnutí – respektovat tempo",
];

const CrisisSafetyChecklist = () => (
  <div className="space-y-2">
    {items.map((item, i) => (
      <div key={i} className="flex items-start gap-2.5 text-sm text-foreground/90">
        <AlertTriangle className="w-3.5 h-3.5 text-destructive mt-1 shrink-0" />
        <p>{item}</p>
      </div>
    ))}
  </div>
);

export default CrisisSafetyChecklist;
