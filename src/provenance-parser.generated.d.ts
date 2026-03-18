/** Auto-generated Peggy parser type declaration. */

export interface PegParty {
  name: string;
  dates: string | null;
  role: string | null;
}

export interface PegPrice {
  amount: number;
  currency: string;
}

export interface PegAstNode {
  type: string;
  uncertain: boolean;
  citations: null[];
  parties: PegParty[];
  extraParties?: PegParty[];
  location: string | null;
  dateExpression: string | null;
  dateYear: number | null;
  dateQualifier: string | null;
  price: PegPrice | null;
  saleDetails: string | null;
  rawRest?: string;
  _poss?: string;
  _fromWhom?: boolean;
  _byWhom?: boolean;
  _hasTo?: boolean;
  _anaphoricRole?: string;
  saleSection?: string;
}

export function parse(input: string, options?: { startRule?: string }): PegAstNode;
