import { Check } from 'lucide-react';

type StepState = 'completed' | 'current' | 'upcoming';

export function StepProgress({ current, labels }: { current: number; labels: string[] }) {
  return (
    <div className="step-progress" role="list" aria-label="Progress">
      {labels.map((label, index) => {
        const stepNumber = index + 1;
        const state: StepState = stepNumber < current ? 'completed' : stepNumber === current ? 'current' : 'upcoming';
        return (
          <div className={`step-progress-item ${state}`} role="listitem" key={label} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="step-progress-dot" aria-hidden="true">{state === 'completed' ? <Check size={14}/> : stepNumber}</span>
            <span className="step-progress-label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
