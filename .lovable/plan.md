
Jednoduše: znamená to, že backend tvé aplikace už jede skoro “na doraz”.

Co se tím myslí:
- dochází výkon nebo kapacita
- aplikace může začít být pomalá
- může se stát, že některé věci budou timeoutovat nebo se nenačtou
- v horším případě něco přestane dočasně fungovat

Lovable tě varuje typicky když je skoro plný některý z těchto limitů:
- málo volného místa
- vysoké zatížení CPU
- slabá zbývající kapacita pro operace databáze / disku

Co s tím udělat:
1. Otevři Cloud
2. Jdi do Overview
3. Otevři Advanced settings
4. Vyber větší instance size

Co se stane potom:
- backend dostane víc výkonu a kapacity
- obvykle pár minut trvá, než se změna projeví
- potom by se měly zlepšit pomalé načítání, timeouty a nestabilita

Na co myslet:
- větší instance = vyšší cloud náklady
- pokud teď aplikace funguje pomalu nebo občas padá, upgrade dává smysl
- pokud je projekt malý a warning se objevil jen jednou, stačí to sledovat, ale ignorovat dlouhodobě to není dobré

Moje praktické doporučení:
- pokud už vidíš bugy typu nenačítání dat, blank screen, pomalé dashboardy nebo padání edge funkcí, upgrade udělej hned
- pokud nic nepadá, ale warning se opakuje, stejně bych šel aspoň o jeden stupeň výš

Jak to najdeš:
- Desktop: v projektu otevři Cloud → Overview → Advanced settings
- Mobile: v chatu klepni na … → Cloud → Overview → Advanced settings

Technická poznámka:
- nejde o chybu v UI, ale o varování, že kapacita backendu je skoro vyčerpaná
- po změně velikosti může trvat několik minut, než se data začnou znovu načítat normálně

<lov-actions>
<lov-suggestion message="Test the app end-to-end after upgrading the Cloud instance to confirm dashboards, chat, and edge functions load correctly.">Verify that it works</lov-suggestion>
<lov-suggestion message="Explain which Cloud instance size is the safest next step for this project based on likely load, dashboard usage, and AI functions.">Doporuč mi velikost instance</lov-suggestion>
<lov-suggestion message="Show me step-by-step where to find Cloud → Overview → Advanced settings on desktop and mobile.">Ukaž mi to krok za krokem</lov-suggestion>
</lov-actions>
