/** A small three-generation GEDCOM with the awkward parts real exports have. */
export const SAMPLE_GED = `﻿0 HEAD
1 SOUR Ancestry.com Family Trees
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @S1@ SOUR
1 TITL 1910 United States Federal Census
1 AUTH Ancestry.com
1 WWW https://www.ancestry.com/search/collections/7884/
0 @I1@ INDI
1 NAME Johann /Ettinger/
2 GIVN Johann
2 SURN Ettinger
1 SEX M
1 BIRT
2 DATE 12 MAR 1871
2 PLAC Baden, Germany
1 DEAT
2 DATE 1940
2 PLAC Chicago, Illinois, USA
1 IMMI
2 DATE 1892
2 PLAC New York
1 OCCU Baker
1 NOTE Came over on the SS Elbe. Ran a bakery on
2 CONC  Halsted Street for thirty years.
2 CONT Grandma said he never lost the accent.
1 FAMS @F1@
1 SOUR @S1@
2 PAGE Sheet 4A, line 12
1 _APID 1,7884::12345
0 @I2@ INDI
1 NAME Maria /Weber/
1 SEX F
1 BIRT
2 DATE ABT 1875
1 DEAT
2 DATE 1952
1 FAMS @F1@
0 @I3@ INDI
1 NAME Karl /Ettinger/
1 SEX M
1 BIRT
2 DATE 1899
2 PLAC Chicago, Illinois, USA
1 DEAT
2 DATE 1971
1 FAMC @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME Anna /Ettinger/
1 SEX F
1 BIRT
2 DATE 1903
1 DEAT
2 DATE 1990
1 FAMC @F1@
2 PEDI adopted
0 @I5@ INDI
1 NAME Rose /Klein/
1 SEX F
1 BIRT
2 DATE 1901
1 DEAT
2 DATE 1985
1 FAMS @F2@
0 @I6@ INDI
1 NAME Robert /Ettinger/
1 SEX M
1 BIRT
2 DATE 1930
1 DEAT
2 DATE 2010
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 DATE 1897
2 PLAC Chicago
1 CHIL @I3@
1 CHIL @I4@
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I5@
1 MARR
2 DATE 1925
1 CHIL @I6@
0 TRLR
`
