import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  onSubmit: (topic: string, createdBy: string) => void;
  onCancel: () => void;
}

const ResearchNewTopicDialog = ({ onSubmit, onCancel }: Props) => {
  const [topic, setTopic] = useState("");
  const [createdBy, setCreatedBy] = useState("");

  return (
    <div className="max-w-md mx-auto px-4 py-8">
      <div className="text-center mb-6">
        <h2 className="text-lg font-serif font-semibold text-foreground">Nové výzkumné téma</h2>
        <p className="text-sm text-muted-foreground mt-1">Zadej název tématu a kdo rešerši zahajuje</p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground mb-1 block">Téma rešerše</label>
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="např. Sandplay terapie u dětí s traumatem"
            autoFocus
          />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground mb-1 block">Kdo hledá?</label>
          <div className="flex gap-2">
            <Button
              variant={createdBy === "Hana" ? "default" : "outline"}
              size="sm"
              onClick={() => setCreatedBy("Hana")}
              className="flex-1"
            >
              💗 Hana
            </Button>
            <Button
              variant={createdBy === "Káťa" ? "default" : "outline"}
              size="sm"
              onClick={() => setCreatedBy("Káťa")}
              className="flex-1"
            >
              💙 Káťa
            </Button>
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} className="flex-1">Zpět</Button>
          <Button onClick={() => onSubmit(topic, createdBy)} disabled={!topic.trim() || !createdBy} className="flex-1">
            Začít rešerši
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ResearchNewTopicDialog;
