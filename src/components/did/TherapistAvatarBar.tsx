import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const avatars = [
  { name: "Hanka", fallback: "H", src: "/avatars/hanka.png" },
  { name: "Karel Gustav Jung", fallback: "K", src: "/avatars/karel.png" },
  { name: "Káťa", fallback: "Ká", src: "/avatars/kata.png" },
] as const;

const TherapistAvatarBar = () => (
  <TooltipProvider delayDuration={300}>
    <div className="flex items-center -space-x-1.5">
      {avatars.map((a) => (
        <Tooltip key={a.name}>
          <TooltipTrigger asChild>
            <Avatar className="h-7 w-7 border-2 border-background shadow-sm">
              <AvatarImage src={a.src} alt={a.name} className="object-cover" />
              <AvatarFallback className="text-[10px] font-semibold bg-muted text-muted-foreground">
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
