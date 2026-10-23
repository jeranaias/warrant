// TODO(agents): typed tool list. The only money tool is submitProposal(PaymentProposal).
import type { PaymentProposal } from "@warrant/contracts";

export interface AgentTools {
  submitProposal(proposal: PaymentProposal): Promise<{ proposalId: string }>;
}
