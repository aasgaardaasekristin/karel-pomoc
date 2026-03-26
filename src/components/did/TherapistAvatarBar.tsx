import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const avatars = [
  { name: "Karel Gustav Jung", fallback: "K", src: "/avatars/karel.jpg" },
  { name: "Hanka", fallback: "H", src: "/avatars/hanka.jpg" },
  { name: "Káťa", fallback: "Ká", src: "/avatars/kata.jpg" },
] as const;

const TherapistAvatarBar = () => (
  <TooltipProvider delayDuration={300}>
    <div className="flex items-center gap-2">
      {avatars.map((a) => (
        <Tooltip key={a.name}>
          <TooltipTrigger asChild>
            <Avatar className="h-9 w-9 border-2 border-white/60 shadow-md">
              <AvatarImage src={a.src} alt={a.name} />
              <AvatarFallback className="text-xs font-semibold bg-muted text-muted-foreground">
                {a.fallback}
              </AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {a.name}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  </TooltipProvider>
);

export default TherapistAvatarBar;
