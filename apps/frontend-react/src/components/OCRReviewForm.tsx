import React, { useState } from 'react';
import { Card, Input, Button, Alert } from '@/components/ui';
import { Check, X, AlertTriangle, FileText } from 'lucide-react';

interface OCRExtractedData {
  normal_hours: number;
  normal_rate: number;
  gross_base: number;
  overtime_hours: number;
  overtime_rate: number;
  gross_overtime: number;
  gross_allowances: number;
  reserveringen_paid: number;
  loonheffing: number;
  zorgverzekering: number;
  huisvesting: number;
  net_additions: { [key: string]: number };
}

interface OCRReviewFormProps {
  ocrData: OCRExtractedData;
  pdfUrl: string;
  confidence: number;
  onConfirm: (correctedData: OCRExtractedData) => void;
  onReject: () => void;
}

export const OCRReviewForm: React.FC<OCRReviewFormProps> = ({ ocrData, pdfUrl, confidence, onConfirm, onReject }) => {
  const [editedData, setEditedData] = useState<OCRExtractedData>(ocrData);
  const [hasChanges, setHasChanges] = useState(false);

  const handleFieldChange = (field: string, value: string) => {
    const numValue = parseFloat(value) || 0;
    setEditedData(prev => ({ ...prev, [field]: numValue }));
    setHasChanges(true);
  };

  const getConfidenceColor = (value: number) => {
    if (value > 95) return 'text-green-600';
    if (value > 80) return 'text-yellow-600';
    return 'text-red-600';
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-2">Zweryfikuj odczytane dane</h1>
      <p className="text-gray-600 mb-6">Sprawdź, czy dane z OCR są zgodne z Twoim paskiem płacowym</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="sticky top-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center"><FileText className="mr-2 h-5 w-5" />Twój pasek płacowy</h2>
            <span className={`text-sm font-medium ${getConfidenceColor(confidence)}`}>Pewność OCR: {confidence}%</span>
          </div>
          <div className="border rounded-lg overflow-hidden" style={{ height: '600px' }}>
            <iframe src={pdfUrl} className="w-full h-full" title="Payslip PDF" />
          </div>
        </Card>
        <div className="space-y-6">
          {confidence < 80 && <Alert type="warning"><AlertTriangle className="h-5 w-5 mr-2" />Niska pewność odczytu OCR.</Alert>}
          <Card>
            <h2 className="text-lg font-semibold mb-4">Wynagrodzenie podstawowe</h2>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium mb-1">Godziny</label><Input type="number" step="0.01" value={editedData.normal_hours} onChange={(e) => handleFieldChange('normal_hours', e.target.value)} /></div>
              <div><label className="block text-sm font-medium mb-1">Stawka</label><Input type="number" step="0.01" value={editedData.normal_rate} onChange={(e) => handleFieldChange('normal_rate', e.target.value)} /></div>
              <div className="col-span-2"><label className="block text-sm font-medium mb-1">Brutto podstawowe</label><Input type="number" step="0.01" value={editedData.gross_base} onChange={(e) => handleFieldChange('gross_base', e.target.value)} /></div>
            </div>
          </Card>
          <Card>
            <h2 className="text-lg font-semibold mb-4">Nadgodziny</h2>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium mb-1">Godziny</label><Input type="number" step="0.01" value={editedData.overtime_hours} onChange={(e) => handleFieldChange('overtime_hours', e.target.value)} /></div>
              <div><label className="block text-sm font-medium mb-1">Stawka</label><Input type="number" step="0.01" value={editedData.overtime_rate} onChange={(e) => handleFieldChange('overtime_rate', e.target.value)} /></div>
              <div className="col-span-2"><label className="block text-sm font-medium mb-1">Brutto nadgodziny</label><Input type="number" step="0.01" value={editedData.gross_overtime} onChange={(e) => handleFieldChange('gross_overtime', e.target.value)} /></div>
            </div>
          </Card>
          <Card>
            <h2 className="text-lg font-semibold mb-4">Potrącenia</h2>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium mb-1">Loonheffing</label><Input type="number" step="0.01" value={editedData.loonheffing} onChange={(e) => handleFieldChange('loonheffing', e.target.value)} /></div>
              <div><label className="block text-sm font-medium mb-1">Zorgverzekering</label><Input type="number" step="0.01" value={editedData.zorgverzekering} onChange={(e) => handleFieldChange('zorgverzekering', e.target.value)} /></div>
              <div className="col-span-2"><label className="block text-sm font-medium mb-1">Huisvesting</label><Input type="number" step="0.01" value={editedData.huisvesting} onChange={(e) => handleFieldChange('huisvesting', e.target.value)} className={editedData.huisvesting > 200 ? 'border-red-400' : ''} /></div>
            </div>
          </Card>
          <div className="flex justify-between">
            <Button variant="outline" onClick={onReject} className="flex items-center"><X className="mr-2 h-4 w-4" />Odrzuć i wczytaj ponownie</Button>
            <Button onClick={() => onConfirm(editedData)} className="flex items-center"><Check className="mr-2 h-4 w-4" />{hasChanges ? 'Zatwierdź poprawione dane' : 'Dane poprawne, analizuj'}</Button>
          </div>
        </div>
      </div>
    </div>
  );
};
