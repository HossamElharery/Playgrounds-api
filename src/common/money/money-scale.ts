/** Legacy Matchena records use hundredths. New gaming records declare ISO minor units. */
export function isoMoneyScale(currency:string){return 10**(new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2);}
export function rescaleMoney(amount:number,from=100,to=100){return amount*to/from;}
export function legacyMoney(row:{amount:number;moneyScale?:number}){return rescaleMoney(row.amount,row.moneyScale??100,100);}
export const paymentLegacySql=(alias='p')=>`(${alias}."amount"::numeric*100/${alias}."moneyScale")`;
