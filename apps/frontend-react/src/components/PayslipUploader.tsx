import React, { useState } from 'react';
import { Upload, AlertCircle } from 'lucide-react';

export const PayslipUploader: React.FC = () => {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowedTypes.includes(file.type)) {
      setUploadError('Nieobsługiwany format pliku. Akceptowane: PDF, JPEG, PNG');
      return;
    }
    setIsUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('payslip', file);
      const response = await fetch('/api/payslip/analyze', { method: 'POST', body: formData });
      if (!response.ok) throw new Error('Błąd podczas analizy');
      const result = await response.json();
      window.location.href = `/dashboard/${result.analysisId}`;
    } catch (error) {
      setUploadError('Wystąpił błąd podczas przetwarzania pliku. Spróbuj ponownie.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold mb-2">Analiza holenderskiego paska płacowego</h1>
        <p className="text-gray-600">Prześlij swój salarisspecificatie, a my sprawdzimy jego poprawność</p>
      </div>
      <div className="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
        <input type="file" onChange={handleFileUpload} accept=".pdf,.jpg,.jpeg,.png" className="hidden" id="file-upload" />
        <label htmlFor="file-upload" className="cursor-pointer">
          <Upload className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <p className="text-lg font-semibold mb-2">{isUploading ? 'Przetwarzanie...' : 'Kliknij, aby przesłać plik'}</p>
          <p className="text-sm text-gray-500">PDF, JPEG lub PNG do 10MB</p>
        </label>
      </div>
      {uploadError && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start">
          <AlertCircle className="h-5 w-5 text-red-500 mr-2 mt-0.5" />
          <p className="text-red-700">{uploadError}</p>
        </div>
      )}
    </div>
  );
};
