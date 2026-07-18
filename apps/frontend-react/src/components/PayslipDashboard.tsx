import React, { useState } from 'react';
import { Card, Button, Alert } from '@/components/ui';

interface PayslipDashboardProps {
  validationResult: any;
  aiAnalysis: any;
}

export const PayslipDashboard: React.FC<PayslipDashboardProps> = ({ validationResult, aiAnalysis }) => {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Card className="mb-6">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold">Twoja wypłata - Podsumowanie</h2>
            <p className="text-gray-600">Okres: {validationResult.period}</p>
          </div>
          <div className={`text-3xl font-bold ${validationResult.isValid ? 'text-green-600' : 'text-red-600'}`}>
            €{validationResult.actualNet.toFixed(2)}
            <span className="text-sm block">Netto do wypłaty</span>
          </div>
        </div>
      </Card>

      {!validationResult.isValid && (
        <Alert type="warning" className="mb-6">
          <h3 className="font-bold">Znaleziono niezgodności!</h3>
          <ul className="list-disc pl-4">
            {validationResult.discrepancies.map((disc: string, idx: number) => (
              <li key={idx}>{disc}</li>
            ))}
          </ul>
        </Alert>
      )}

      {aiAnalysis && (
        <Card className="mb-6 bg-blue-50">
          <h3 className="text-xl font-bold mb-4">🤖 Analiza AI Twojej wypłaty</h3>
          <p>{aiAnalysis.summary}</p>
          {showDetails && (
            <ul className="list-disc pl-4 mt-4">
              {aiAnalysis.details.map((detail: string, idx: number) => (
                <li key={idx}>{detail}</li>
              ))}
            </ul>
          )}
          <Button onClick={() => setShowDetails(!showDetails)} className="mt-4">
            {showDetails ? 'Ukryj szczegóły' : 'Pokaż szczegóły'}
          </Button>
        </Card>
      )}
    </div>
  );
};
