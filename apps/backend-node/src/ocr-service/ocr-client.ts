import { TextractClient, AnalyzeDocumentCommand } from "@aws-sdk/client-textract";

const client = new TextractClient({
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ""
  }
});

export async function extractPayslipData(fileBuffer: Buffer): Promise<any> {
  const command = new AnalyzeDocumentCommand({
    Document: { Bytes: fileBuffer },
    FeatureTypes: ["FORMS", "TABLES"]
  });

  const response = await client.send(command);
  const blocks = response.Blocks || [];

  // Wyszukiwanie pól formularza
  const fields: any = {};
  for (const block of blocks) {
    if (block.BlockType === "KEY_VALUE_SET" && block.EntityTypes?.includes("KEY")) {
      const key = block.Relationships?.find(r => r.Type === "CHILD")?.Ids?.[0];
      const valueBlock = blocks.find(b => b.Id === key && b.BlockType === "WORD");
      if (valueBlock && block.Text) {
        fields[block.Text.toLowerCase()] = valueBlock.Text;
      }
    }
  }

  return {
    normal_hours: parseFloat(fields["gewerkte uren"] || fields["uren"] || "0"),
    normal_rate: parseFloat(fields["uurloon"] || "0"),
    gross_base: parseFloat(fields["brutoloon"] || "0"),
    overtime_hours: parseFloat(fields["overuren"] || "0"),
    overtime_rate: parseFloat(fields["overurentarief"] || "0"),
    gross_overtime: parseFloat(fields["bruto overwerk"] || "0"),
    loonheffing: parseFloat(fields["loonheffing"] || "0"),
    zorgverzekering: parseFloat(fields["zorgverzekering"] || "0"),
    huisvesting: parseFloat(fields["huisvesting"] || "0"),
  };
}
