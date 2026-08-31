# MASTER PRODUCT & TECHNICAL SPECIFICATION
# Organic Growth Operating System
## Autonomous SEO + AEO + GEO Platform

Version: 1.0
Architecture principle: Research → Decide → Plan → Snapshot → Execute → Validate → Deploy → Measure → Learn
Primary CMS V1: WordPress
Primary build environment: Claude Code
Primary objective: מערכת SaaS Multi-Tenant שמסוגלת לחקור, לנתח, לתכנן, לבצע, לבדוק ולשפר SEO / AEO / GEO בצורה אוטומטית ובטוחה.

---

# 0. הוראה ראשית ל-Claude Code

אל תנסה לבנות את כל המערכת במהלך אחד.

המערכת חייבת להיבנות בצורה מודולרית, היררכית ומדורגת.

לפני כתיבת קוד:

1. קרא את המסמך במלואו.
2. הפק Architecture Map.
3. הפק Dependency Map.
4. חלק את הפיתוח ל-Phases.
5. זהה אילו מודולים Deterministic ואילו באמת דורשים LLM.
6. הגדר contracts בין המודולים.
7. הגדר Database Schema.
8. הגדר Acceptance Tests.
9. רק לאחר מכן התחל Phase 0.

אין לבנות placeholder מזויף של פיצ'רים עתידיים.
אין לייצר fake data כדי לגרום לממשק להיראות עובד.
אין לסמן feature כ-complete אם הוא אינו פועל מקצה לקצה.

כל Phase חייב לעבור:
BUILD → TEST → REVIEW → SECURITY → COST REVIEW
לפני מעבר ל-Phase הבא.

---

# 1. חזון המוצר

המוצר אינו SEO Audit Tool.

המוצר הוא:

# Organic Growth Operating System

שמחליף חלק משמעותי מעבודת:
- SEO Manager
- Technical SEO
- Content Strategist
- Content Writer
- Internal Linking Specialist
- Schema Specialist
- GEO/AEO Specialist
- Analytics Analyst
- SEO QA
- SEO Monitoring
- Digital PR Analyst

המערכת אינה רק אומרת:
"מצאנו 184 בעיות."

אלא:
"מצאנו 184 הזדמנויות, חישבנו איזו פעולה צפויה לתת את הערך העסקי הגבוה ביותר, ביצענו אותה בבטחה, בדקנו שלא נשבר דבר ומדדנו את התוצאה."

---

# 2. מעגל העבודה המרכזי

CONNECT
↓
DISCOVER
↓
CRAWL
↓
UNDERSTAND
↓
ANALYZE
↓
PRIORITIZE
↓
PLAN
↓
SNAPSHOT
↓
PATCH
↓
VALIDATE
↓
DEPLOY
↓
QA
↓
INDEXATION PIPELINE
↓
MONITOR
↓
MEASURE
↓
LEARN
↓
REPRIORITIZE

המערכת חוזרת על המחזור באופן מתמשך.

---

# 3. עקרונות יסוד

## 3.1 AI לא מנהל את המערכת

Workflow orchestration חייב להיות deterministic.

LLM משמש רק כאשר נדרשים:
- הבנת משמעות
- classification מורכב
- search intent
- ניתוח תוכן
- אסטרטגיית תוכן
- כתיבה
- reasoning עסקי
- semantic judgment
- root cause analysis

קוד רגיל משמש לכל מה שניתן לבצע באמצעות:
- HTTP
- SQL
- regex
- parser
- DOM
- crawler
- JSON
- rules
- statistics
- graph algorithms
- hashing
- schema validation

---

# 4. עיקרון Token Efficiency

זה עיקרון ארכיטקטוני, לא optimization מאוחר.

אסור לשלוח LLM דברים שקוד יכול להבין לבד.

לדוגמה:
404? קוד.
Missing H1? קוד.
Canonical? קוד.
Duplicate title? SQL.
Broken link? Crawler.
Schema syntax? Validator.
Page similarity ראשוני? Embeddings / hashes.

רק אחרי filtering משתמשים ב-LLM.

---

# 5. Hierarchical Context System

לא שולחים למודל אתר שלם.

יש 5 רמות Context.

## LEVEL 1 — Organization Capsule
מידע קבוע:
- brand
- business
- industry
- products
- services
- audience
- locations
- experts
- tone
- business objectives

## LEVEL 2 — Site Capsule
סיכום האתר:
- architecture
- main topics
- primary entities
- page types
- performance overview

## LEVEL 3 — Topic Capsule
לכל Cluster:
- keywords
- intent
- related pages
- topical gaps
- entities
- SERP patterns

## LEVEL 4 — Page Capsule
לכל URL:
- content summary
- headings
- primary keyword
- metrics
- internal links
- schema
- issues
- opportunities

## LEVEL 5 — Task Context
רק המידע הדרוש לפעולה הספציפית.

לדוגמה:
אם משפרים Title:
לא שולחים מאמר של 3,000 מילים.
שולחים:
- current title
- H1
- page summary
- primary keyword
- top queries
- CTR
- intent
- brand rules

---

# 6. Token Budget Manager

כל LLM Task חייב להכיל:
- estimated_input_tokens
- max_input_tokens
- max_output_tokens
- model_class
- expected_cost
- actual_cost
- cache_status
- escalation_count

המערכת תאפשר:
Daily AI Budget
Monthly AI Budget
Per Client Budget
Per Task Budget

---

# 7. Model Router

אסור להשתמש במודל החזק ביותר לכל דבר.

שלוש רמות:

## FAST
ל:
- classification
- formatting
- extraction validation
- simple relevance decision
- content tagging

## BALANCED
ל:
- keyword intent
- semantic analysis
- content briefs
- content improvement
- internal link judgment

## STRONG
רק ל:
- complex strategy
- ambiguous cannibalization
- major content architecture
- high-risk recommendations
- sophisticated competitor analysis
- difficult root cause analysis

ה-model mapping יהיה Configurable ולא Hardcoded.

לדוגמה:
MODEL_FAST
MODEL_BALANCED
MODEL_STRONG

---

# 8. LLM Cache

כל קריאה נשמרת לפי:
hash(model + prompt_version + input)

Amended 2026-08-31:
המפתח כולל גם tenant scope (cache namespace):
hash(tenant_scope + model + prompt_version + canonical_input)

Global cache מותר רק ל-tasks שסווגו במפורש כ-non-tenant/public.
ראו AI-COST-ARCHITECTURE.md §5.1.

אם אותו Input כבר נותח:
לא לבצע LLM call מחדש.

---

# 9. Content Hashing

לכל עמוד נשמור:
content_hash
heading_hash
metadata_hash
schema_hash
template_hash

אם העמוד לא השתנה:
לא מנתחים אותו שוב.

---

# 10. Embedding Cache

Embedding נוצר פעם אחת לכל content hash.
לא לייצר embeddings מחדש בכל crawl.

---

# 11. Diff-Based Analysis

אם עמוד השתנה רק בפסקה אחת:
לא מנתחים מחדש 4,000 מילים.

מנתחים:
DIFF
+
Relevant Context.

---

# 12. Boilerplate Removal

לפני LLM להסיר:
- navigation
- footer
- cookie banner
- repeated sidebar
- menus
- unrelated widgets
- repeated global components

LLM מקבל רק main content.

---

# 13. Retrieval Limits

ברירת מחדל:
Top-K קטן.

לדוגמה:
5–10 chunks.

לא לשלוח 100 chunks "ליתר ביטחון".
ניתן להרחיב רק אם Confidence נמוך.

---

# 14. מערכת חיבורים

## Required
### WordPress
### Google Search Console
### GA4
### Google Tag Manager
### Keyword Research Upload
CSV/XLSX.

---

# 15. Optional Integrations

- SERP provider
- PageSpeed / CrUX
- BigQuery
- Cloudflare
- server logs
- Google Business Profile
- Bing Webmaster
- IndexNow
- YouTube
- social platform Search Console properties
- backlink provider
- email provider
- CRM
- Slack
- webhook
- Looker Studio export

כל Integration חייב להיות Adapter.

אסור שה-Core יהיה תלוי ב-provider מסוים.

לדוגמה:
SerpProviderInterface
BacklinkProviderInterface
LLMProviderInterface
StorageProviderInterface

---

# 16. WordPress Connector

בנוסף ל-REST API הרגיל יש לבנות:

# OrganicOS WordPress Connector Plugin

ה-plugin יהיה Safety Bridge.

הוא חייב לתמוך ב:
- authentication
- capabilities
- posts
- pages
- CPT
- taxonomies
- media
- metadata
- revisions
- redirects
- SEO plugins
- builder detection
- schema
- cache invalidation
- snapshots
- rollback

## Phased Delivery (Amended 2026-08-31)

ה-plugin נבנה בשלבים:
- v1 (Phase 1): READ ONLY בלבד — health, capabilities, inventory, content.
  Write endpoints אינם קיימים ב-build.
- v2 (Phase 4): write bridge — snapshot, apply, restore, cache invalidation,
  מוגבל ל-action types הנתמכים בשלב.
- v3+ (Phase 7+): SEO plugin adapters מעמיקים, builder adapters.

ראו: ADR-0010.

---

# 17. WordPress Authentication

להשתמש ב:
HTTPS
+
Application Password / secure token method.

Credentials מוצפנים.
לא לשמור plaintext.

---

# 18. Builder Detection

לזהות:
- Gutenberg
- Elementor
- Classic Editor
- ACF
- WooCommerce
- custom theme

אסור לבצע blind overwrite של Elementor JSON.
שינויים ב-builders יתבצעו דרך adapter מתאים.

---

# 19. SEO Plugin Adapters

Adapter עבור:
- Yoast
- RankMath
- native
- custom fields

להפריד:
SeoMetadataProvider.

---

# 20. Digital Twin

לכל אתר המערכת בונה Representation פנימי.

לכל URL נשמר:
- URL
- WP ID
- content type
- template
- builder
- status
- HTTP status
- redirect
- canonical
- robots
- title
- meta description
- H1
- headings
- content
- word count
- images
- ALT
- internal links
- external links
- inbound links
- schema
- breadcrumbs
- language
- hreflang
- crawl depth
- sitemap membership
- index status
- last Google crawl
- Core Web Vitals
- JavaScript errors
- accessibility issues
- GSC metrics
- GA4 metrics
- conversions
- revenue
- keyword cluster
- search intent
- business value
- risk
- content quality
- topical contribution
- SEO score
- AEO score
- GEO score

---

# 21. Crawl Engine

לבנות Crawler עצמאי.

שני Modes:

## HTTP FAST CRAWL
ברירת המחדל.

## RENDERED CRAWL
Playwright.

רק כאשר:
- JS-heavy
- content mismatch
- SPA
- DOM requires rendering
- validation requires screenshot

כך נחסוך CPU וזמן.

---

# 22. Crawl Rules

Respect:
- robots
- rate limits
- server health
- crawl budgets configured by user

להימנע מ:
- crawler traps
- infinite parameters
- calendars
- session URLs
- infinite pagination

---

# 23. Incremental Crawl

Full Crawl:
ב-onboarding.

לאחר מכן:
Incremental Crawls.

עדיפות ל:
- changed pages
- important pages
- new pages
- error pages
- recently optimized pages

---

# 24. Search Console Intelligence

למשוך:
- query
- page
- clicks
- impressions
- CTR
- position
- device
- country
- dates
- search appearance כאשר זמין

תקופות:
7
28
90
180
365 ימים.

לחשב:
- trend
- momentum
- decline
- CTR gap
- ranking opportunity
- cannibalization
- query expansion
- new keywords
- lost keywords

---

# 25. Search Console Data Quality

Search Analytics API אינו בהכרח מקור מושלם לכל long-tail row.

לכן:
אתרים גדולים יוכלו אופציונלית לחבר:
Search Console Bulk Export → BigQuery.

המנוע צריך לבחור:
Small site: API.
Large site: Bulk Export preferred כאשר מוגדר.

---

# 26. Google AI Search Data

כאשר Google מספקת נתוני Generative AI performance דרך API/Export רשמי:
למשוך אותם.

אם הנתונים זמינים רק ב-Search Console UI:
לא לגרד את הממשק.
לא להמציא API.

להציג:
DATA SOURCE NOT PROGRAMMATICALLY AVAILABLE

ולהפעיל feature flag עד שקיים source רשמי.

---

# 27. GA4 Intelligence

למשוך:
- landing pages
- sessions
- users
- engagement
- events
- key events
- leads
- purchases
- revenue
- conversion rate

לחבר Page → Organic Search → Business Result.

---

# 28. GTM Auditor

לנתח:
- containers
- workspaces
- tags
- triggers
- variables
- versions

לזהות:
- duplicate GA4
- broken conversions
- missing events
- form tracking
- phone clicks
- WhatsApp
- purchases
- duplicate firing
- consent problems

שינויים ב-GTM יתבצעו תחילה ב-Workspace נפרד.
לא לפרסם אוטומטית שינוי GTM בסיכון גבוה.

---

# 29. Keyword Intelligence Engine

קלט:
CSV/XLSX.

שדות אפשריים:
- keyword
- volume
- difficulty
- CPC
- intent
- location
- language

המערכת תבצע:
Normalize
↓
Deduplicate
↓
Cluster
↓
Intent
↓
Topic
↓
Business Value
↓
URL Mapping.

---

# 30. Keyword Clustering חסכוני

שלב 1:
Lexical similarity.

שלב 2:
Embeddings.

שלב 3:
SERP overlap אם קיים.

שלב 4:
LLM רק עבור clusters ambiguous.

לא לבצע LLM classification על כל keyword אם אין צורך.

---

# 31. Keyword → URL Mapping

כל Keyword יקבל:
Primary target URL
או:
CREATE PAGE
או:
MERGE
או:
NO ACTION.

---

# 32. Cannibalization Engine

לא להסתפק ב-keyword overlap.

לשלב:
- query overlap
- URL switching
- ranking volatility
- semantic similarity
- search intent
- internal anchors
- SERP competition

Output:
KEEP BOTH
REFOCUS
MERGE
REDIRECT
RESTRUCTURE.

---

# 33. SERP Intelligence

Provider modular.
לאחסן snapshots לאורך זמן.

לכל query:
- ranking URLs
- domains
- result types
- content type
- SERP features
- titles
- intent
- freshness
- video
- images
- local
- forums
- AI features כאשר ניתנות לזיהוי באופן חוקי ואמין

---

# 34. Search Intent Drift

להשוות SERP לאורך זמן.

לדוגמה:
Informational → Commercial.

ולהתריע:
CURRENT PAGE TYPE MAY NO LONGER MATCH INTENT.

---

# 35. Competitor Change Radar

לעקוב:
- new pages
- removed pages
- changed pages
- topic expansion
- titles
- schema
- backlinks
- content freshness

לא לבצע full competitor LLM analysis בכל יום.
להשתמש ב-hashes + diffs.

---

# 36. Why Are They Winning Engine

השוואה מול מתחרה עבור Query/Cluster.

Factors:
- intent match
- content coverage
- topical authority
- internal linking
- external links
- entities
- freshness
- media
- schema
- page UX
- brand authority

התוצאה חייבת להיות Explainable.

---

# 37. Opportunity Engine

כל finding הופך ל:
Opportunity.

Opportunity כולל:
- problem
- evidence
- affected URLs
- recommended action
- SEO contribution
- AEO contribution
- GEO contribution
- business value
- confidence
- effort
- risk
- expected impact
- estimated cost

---

# 38. Opportunity Score

לא hardcode נוסחה סופית.
Versioned Scoring Engine.

Baseline:
Impact × Confidence × Business Value × Data Strength
חלקי:
Effort × Risk.

כל שינוי בנוסחה יקבל:
scoring_version.

---

# 39. Next Best Action

המערכת לא תציג רק 300 Opportunities.
היא תדע:
# What should we do next?

לאחר כל פעולה:
Recalculate priorities.

---

# 40. ROI Forecast

לנסות להעריך:
Current clicks
Current position
Potential position
Expected CTR delta
Potential sessions
Conversion rate
Average conversion value.

Output:
Estimated Organic Business Opportunity.

התחזית תסומן:
Estimate
ולא עובדה.

---

# 41. Autonomous Roadmap

המנוע ייצור Roadmap.

לדוגמה:
Phase A: Critical technical.
Phase B: High-value quick wins.
Phase C: Content optimization.
Phase D: Authority building.
Phase E: New content.
Phase F: GEO/AEO.

---

# 42. Content Intelligence Engine

זה Module מרכזי.

לכל URL המערכת יכולה לבחור:
KEEP
OPTIMIZE
EXPAND
REFRESH
REWRITE
MERGE
SPLIT
CREATE
REDIRECT
NOINDEX
DELETE.

NOINDEX / DELETE / URL changes:
High Risk.

---

# 43. Content Opportunity Engine

לפני כתיבה:
לשלב:
- keyword research
- existing content
- GSC
- GA4
- SERP
- competitors
- entities
- questions
- business knowledge
- conversion objective

ולהחליט:
האם בכלל צריך עמוד חדש?

---

# 44. Business Knowledge Base

לכל לקוח Source of Truth.

Entity types:
Company
Person
Service
Product
Location
Credential
Award
Case Study
Process
Price
FAQ
Statistic
Claim.

---

# 45. Business Fact Rules

LLM אסור להמציא:
- שנות ניסיון
- מחירים
- תוצאות
- מספר לקוחות
- credentials
- locations
- awards
- guarantees

אם Fact אינו קיים:
UNKNOWN.

---

# 46. Content Brief Engine

לפני תוכן:
Brief כולל:
- primary keyword
- secondary keywords
- intent
- audience
- funnel stage
- page objective
- competitors
- content gaps
- entities
- questions
- sources
- internal links
- CTA
- schema
- AEO requirements
- GEO requirements
- originality requirement

---

# 47. Content Writing Engine

לא לכתוב "SEO article" גנרי.

התוכן צריך לשלב:
User Value
+
Search Intent
+
First-party Knowledge
+
Evidence
+
Brand Voice
+
Conversion Objective.

---

# 48. Surgical Content Optimization

ברירת המחדל:
לא rewrite מלא.

אם עמוד עובד:
שינוי ממוקד.

לדוגמה:
Add section.
Improve answer.
Change intro.
Update title.
Add evidence.
Add internal links.

כך:
- פחות Tokens
- פחות Risk
- שומרים מידע שכבר מדורג

---

# 49. Content Originality Engine

לכל Draft לחשב:
Commodity Score.

לשאול:
"מה יש כאן שאין ל-10 תוצאות האחרות?"

דוגמאות:
- proprietary data
- case study
- expert quote
- original process
- firsthand experience
- calculator
- original images
- comparison
- research

---

# 50. First-Party Evidence Engine

לנהל assets כגון:
- case studies
- statistics
- survey data
- testimonials
- expert interviews
- original photos
- videos
- before/after
- process information

ולהציע היכן לשלב אותם.

---

# 51. Claim Ledger

לכל claim משמעותי:
- claim
- source
- source URL
- source authority
- date
- verified_at
- pages_using_claim

כאשר מקור מתיישן:
Alert.

---

# 52. Content Quality Gate

לפני publish:
- factual consistency
- duplicate check
- cannibalization check
- intent match
- keyword stuffing
- brand voice
- readability
- entity accuracy
- source validation
- broken links
- schema/content consistency
- internal linking
- user value
- AI genericness

---

# 53. E-E-A-T / Author Engine

לנהל:
Authors
Reviewers
Credentials
Bios
Expertise areas
Profile pages
Schema relationships.

ב-YMYL ניתן לדרוש:
Human Review.

---

# 54. Content Refresh Engine

לזהות:
Content Decay.

Signals:
- rankings decline
- clicks decline
- CTR decline
- competitor improvement
- SERP change
- outdated data
- stale source
- outdated year

וליצור targeted refresh.

---

# 55. Decay Prediction

בעתיד:
ללמוד כמה מהר סוגי content שונים מתיישנים.
לבצע preventative refresh לפני ירידה משמעותית.

---

# 56. Freshness Score

Freshness אינו "גיל העמוד".
הוא תלוי Topic.

לדוגמה:
Definition evergreen
לעומת:
"Prices 2026".

---

# 57. Content Repurposing Engine

Page → Video idea
Page → Reel idea
Page → Social post
Video → Article
Search query → FAQ
Trending social content → Site opportunity.

---

# 58. Internal Authority Engine

ליצור Site Link Graph.

Node:
Page.

Edges:
Internal Links.

Properties:
- inbound
- outbound
- depth
- traffic
- ranking
- conversions
- topic
- business importance

---

# 59. Internal Link Opportunity Engine

לזהות:
- orphan pages
- weak authority pages
- contextually relevant mentions
- new pages
- broken internal links
- overlinked pages
- underlinked commercial pages

---

# 60. Semantic Internal Linking

לא לבצע רק keyword matching.

Pipeline:
Candidate detection
↓
Embedding similarity
↓
Graph relevance
↓
Anchor check
↓
Existing link check
↓
Business priority
↓
LLM judgment רק אם ambiguous.

---

# 61. Anchor Intelligence

לעקוב אחר:
- exact match
- partial match
- brand
- generic
- contextual anchors

למנוע repetitive exact-match patterns.

---

# 62. New Page Linking Rule

אסור לפרסם עמוד חדש ללא:
Inbound link plan
+
Outbound link plan.

---

# 63. Internal Authority Score

Score versioned המבוסס על:
- inbound links
- source importance
- click depth
- traffic
- topic relationship
- commercial importance

אין לקרוא לו "PageRank" אם אינו PageRank אמיתי.

---

# 64. Schema Knowledge Graph Engine

לא "Schema generator" פשוט.
ליצור Entity Graph עקבי.

---

# 65. Persistent Entity IDs

לדוגמה:
domain.com/#organization
domain.com/person/name/#person
domain.com/service/x/#service

Entity ID חייב להישאר יציב.

---

# 66. Schema Types

לפי צורך:
- Organization
- LocalBusiness
- Person
- ProfilePage
- WebSite
- WebPage
- Article
- BlogPosting
- Service
- Product
- Offer
- BreadcrumbList
- VideoObject
- Event
- FAQ כאשר רלוונטי ונתמך
- HowTo רק כאשר מתאים למדיניות/שימוש

---

# 67. שתי שכבות Schema

## Google Supported Layer
Features הנתמכים על ידי Google.

## Semantic Layer
Schema.org relationships רחבים יותר.

אין להבטיח Rich Result.

---

# 68. Schema Validation

לפני deploy:
- JSON syntax
- schema types
- required fields
- recommended fields
- URL validity
- content consistency
- entity consistency
- duplicate entities
- conflicting data

אחרי deploy:
Rendered validation.

---

# 69. Topical Authority Engine

לייצר Topic Graph.

Topic
↓
Subtopic
↓
Entity
↓
Keyword
↓
URL.

---

# 70. Topic Coverage Score

להציג:
Covered
Weak
Missing
Overlapping.

לא למדוד Authority רק לפי "מספר מאמרים".

---

# 71. Entity Authority Engine

לזהות consistency של:
- brand
- experts
- services
- locations
- products
- social profiles
- structured data
- external mentions

---

# 72. AEO Engine

המטרה:
לגרום לתוכן להיות קל להבנה, extraction וציטוט.

לזהות Queries כגון:
- what is
- how
- why
- when
- comparison
- cost
- best
- pros/cons

---

# 73. Answer Units

מבנה:
Question
↓
Direct Answer
↓
Evidence
↓
Explanation
↓
Related Question.

לא להוסיף FAQ מלאכותי לכל עמוד.

---

# 74. Answer Coverage

לכל Cluster:
Questions
Covered
Partially covered
Missing.

---

# 75. GEO Engine

GEO אינו "להוסיף AI schema".

הוא משלב:
- strong content
- entities
- first-party evidence
- citations
- clear answers
- crawlability
- brand authority
- structured information

---

# 76. Query Fan-Out Mapper

לכל complex query:
לזהות subquestions.

לדוגמה:
Main:
Best X for Y.

Fan-out:
price
quality
comparison
risks
requirements
alternatives.

לחשב:
Fan-Out Coverage.

---

# 77. AI Visibility Tracker

Synthetic Benchmark.

רשימת prompts קבועה.

בדיקות תקופתיות מול Providers כאשר API חוקי וזמין.

לשמור:
- brand mention
- competitor mention
- citation
- cited URL
- response timestamp
- model/provider
- prompt version

להציג במפורש:
Synthetic AI Visibility Measurement.

לא "official ranking".

---

# 78. Google Generative AI Visibility

כאשר מקור נתונים רשמי זמין:
להעדיף אותו על Synthetic Monitoring.

---

# 79. AI Crawler Control Center

לבדוק:
robots.txt
WAF
Cloudflare
HTTP status.

Crawler policy support עבור crawlers כגון:
Googlebot
OAI-SearchBot
GPTBot
Google-Extended
Bingbot.

להציג הסבר על משמעות כל bot ולא לערבב search crawl עם training controls.

---

# 80. AI Agent Readiness

באמצעות Browser Agent / Playwright לבדוק Tasks:
- למצוא שירות
- להבין מחיר
- ליצור קשר
- למלא טופס
- לקבוע תור
- לבחור מוצר

Score:
Machine Readability
+
Agent Usability.

---

# 81. Agent Simulation

Agent Test חייב להיות sandboxed.
אסור לשלוח Form אמיתי בלי explicit permission.
ניתן לבצע:
Dry Run.

---

# 82. Preferred Source Support

כאשר האתר Eligible וה-feature זמין:
להציע implementation מתאים.
לא להבטיח eligibility.

---

# 83. Server Log Intelligence

Import/connect:
Cloudflare
Nginx
Apache
או normalized log format.

לזהות:
- Googlebot
- Bingbot
- AI crawlers
- status codes
- crawl frequency
- wasted crawl
- important page crawl

---

# 84. Crawl Efficiency Engine

לחשב:
Important URL Crawl Rate
Crawl Waste
Duplicate Crawl
Parameter Crawl
Error Crawl.

---

# 85. External Authority Engine

מודול backlinks.
Data provider abstract.

---

# 86. Backlink Intelligence

- new links
- lost links
- competitor links
- broken backlinks
- domain relevance
- destination page
- anchor
- authority estimate

---

# 87. Digital PR Opportunities

לזהות:
- competitor mention
- resource page
- journalist article
- unlinked brand mention
- research opportunity
- linkable asset opportunity

---

# 88. Brand Mention Intelligence

Brand / Person / Product mentions.
Linked?
Unlinked?
Positive?
Neutral?
Negative?

---

# 89. Outreach CRM

Optional module:
Prospect
↓
Contact
↓
Outreach
↓
Follow-up
↓
Response
↓
Link/mention acquired.

לא לשלוח mass spam.

---

# 90. Reputation Intelligence

לרכז כאשר integration מאפשר:
- reviews
- testimonials
- mentions
- sentiment
- recurring strengths
- recurring complaints

---

# 91. Technical SEO Engine

אוטומציה עבור:
- status codes
- broken links
- titles
- descriptions
- headings
- canonical
- robots
- sitemap
- redirects
- redirect chains
- orphan URLs
- duplicate content
- thin content
- pagination
- hreflang
- image issues
- structured data
- indexability

---

# 92. Sitemap Engine

לייצר/לאמת:
Indexable canonical URLs בלבד.

לתמוך ב:
Sitemap Index.

Lastmod אמיתי רק כאשר content השתנה.

---

# 93. Indexation Pipeline

אחרי Deploy מוצלח:

Regenerate Sitemap
↓
Validate
↓
Submit Sitemap
↓
Store affected URLs
↓
URL Inspection Monitoring.

עבור URLs רגילים:
אין להשתמש ב-Google Indexing API.

Indexing API מיועד רק לסוגי התוכן ש-Google מאפשרת רשמית.

---

# 94. Index Monitoring

לכל URL:
- indexed
- not indexed
- crawled
- discovered
- canonical selected
- last crawl
- sitemap known
- referring URL כאשר זמין

---

# 95. Image SEO Engine

לבדוק:
- ALT
- filename
- dimensions
- size
- format
- lazy loading
- missing image
- duplicate images
- content relevance

Optional:
WebP / AVIF conversion.

רק עם backup.

---

# 96. Video SEO Engine

- transcript
- title
- description
- thumbnail
- VideoObject
- chapters
- related page
- internal links

---

# 97. Performance Engine

לשלב:
- Lighthouse
- CrUX כאשר זמין
- performance metrics
- resource problems

לא לנסות "לתקן אוטומטית" קוד/theme בסיכון גבוה ב-V1.

---

# 98. Accessibility Engine

לזהות:
- heading semantics
- labels
- ALT
- buttons
- links
- ARIA issues
- DOM semantics

חלק מהנתונים תורמים גם ל-Agent Readiness.

---

# 99. Conversion SEO

SEO success אינו רק Ranking.

לכל landing page:
Organic visits
↓
Engagement
↓
Lead/Purchase
↓
Value.

---

# 100. Conversion Opportunity

עמוד שממיר היטב אך מדורג במקום 8:
עדיפות גבוהה.

עמוד עם traffic רב ו-0 conversion:
צריך Investigation.

---

# 101. SEO Experiment Engine

לתמוך בעתיד:
Control
Test
Change
Measurement Window
Result
Confidence.

Examples:
- titles
- snippets
- content pattern
- internal linking

---

# 102. Action Attribution

כל Action נשמר עם:
Before metrics
Deployment date
After metrics.

לא לטעון causality ודאית.

להציג:
Observed change
+
Attribution confidence.

---

# 103. Safe Execution Engine

זה אחד המודולים החשובים ביותר.

כל שינוי:
PLAN
↓
PATCH
↓
SNAPSHOT
↓
PREFLIGHT
↓
EXECUTE
↓
QA
↓
COMMIT/ROLLBACK.

---

# 104. Action Types

כל שינוי מקבל Action ID.

לדוגמה:
ACT-2026-000001.

---

# 105. Risk Engine

## GREEN
דוגמאות:
- missing ALT
- safe meta description
- additive schema
- broken internal link עם destination ודאי

## YELLOW
- Title
- H1
- content additions
- internal linking batch
- schema replacement
- GTM workspace change

## RED
- URL changes
- mass redirects
- noindex
- deletion
- robots.txt
- navigation
- templates
- builder structure
- GTM publication
- mass content replacement

Risk config ניתן לשינוי.

---

# 106. Autopilot Modes

## OFF
Research only.

## REVIEW
Everything requires approval.

## SAFE AUTOPILOT
Green automatic.
Yellow configurable.
Red approval required.

## FULL AUTOPILOT
אפשרי בעתיד בלבד.

Red עדיין חייב לעבור enhanced safeguards.

ברירת מחדל (Amended 2026-08-31):
REVIEW.

SAFE AUTOPILOT הוא opt-in מפורש פר-אתר.

## Safety Graduation Policy (Amended 2026-08-31)

מעבר אתר ל-SAFE AUTOPILOT דורש עמידה ב-Graduation Policy הניתנת להגדרה.

Baseline מומלץ (configurable, לא hardcoded):
- לפחות 20 GREEN production actions שהושלמו בהצלחה
- כל בדיקות ה-QA הנדרשות עברו
- אפס critical site-impact incidents
- אין rollback failures לא פתורים
- explicit user opt-in

המערכת רשאית להמליץ "site ready for Safe Autopilot".
המערכת לעולם לא מפעילה SAFE AUTOPILOT בעצמה ב-V1.

ראו: ADR-0014, EXECUTION-SAFETY.md §3.

---

# 107. Snapshot System

לפני שינוי:
- WP content
- metadata
- builder data
- schema
- page HTML
- screenshot desktop
- screenshot mobile
- links
- response headers
- relevant metrics

Snapshot נשמר ב-object storage.

---

# 108. Canary Deployment

Batch גדול:
5
↓
QA
↓
10
↓
QA
↓
50
↓
QA
↓
rest.

Dynamic batch sizing בהתאם ל-success rate.

---

# 109. QA Engine

אחרי deploy:
- HTTP 200
- content exists
- expected diff
- canonical
- robots
- headings
- links
- forms
- schema
- JavaScript errors
- GTM presence
- analytics presence
- mobile rendering
- screenshots
- performance critical regressions

---

# 110. Visual Regression

Before screenshot
vs
After screenshot.

Detect:
- missing section
- overlapping content
- missing button
- layout collapse
- broken image
- large unexpected shift

LLM Vision רק אם deterministic visual diff מצא anomaly.

---

# 111. Auto Rollback

אם Critical Validation נכשל:
Rollback אוטומטי.

Action status:
ROLLED_BACK.

לשמור failure reason.

---

# 112. SEO Change Guard

לזהות שינוי שבוצע מחוץ למערכת.

לדוגמה:
- title removed
- noindex added
- page deleted
- canonical changed
- schema disappeared
- redirects changed

להשוות ל-last known good state.

---

# 113. Self-Healing

רק Green scenarios בגרסה ראשונה.

לדוגמה:
Known schema accidentally removed.
Broken internal link with known replacement.
Sitemap stale.

לא לבצע Red self-healing אוטומטי.

---

# 114. Root Cause Engine

אם traffic יורד:
לבדוק:
- tracking
- ranking
- indexation
- page changes
- search demand
- SERP changes
- competitors
- technical errors
- crawl changes

ולהציג ranked hypotheses.

---

# 115. Anomaly Detection

Baselines עבור:
- clicks
- impressions
- organic sessions
- conversions
- indexed URLs
- 404
- 5xx
- crawler activity
- rankings
- AI visibility

---

# 116. Migration Manager

מודול עתידי:

Pre-migration crawl
↓
URL map
↓
redirect plan
↓
migration
↓
post migration QA
↓
GSC monitoring
↓
traffic/ranking watch.

---

# 117. Local SEO Module

Optional vertical.

- locations
- NAP
- local pages
- local keywords
- LocalBusiness schema
- reviews
- branch cannibalization
- Google Business Profile כאשר API/access מאפשר

---

# 118. Ecommerce SEO Module

Optional vertical.

- products
- variants
- categories
- filters
- faceted navigation
- out-of-stock
- expired products
- Product schema
- Merchant-related data
- category linking
- duplicate descriptions

---

# 119. International SEO

- language
- locale
- hreflang
- translation coverage
- canonical
- language intent
- cross-language linking

---

# 120. Social & Search Everywhere

כאשר Search Console או API רשמי מאפשר:
לחבר Platform Properties כגון:
YouTube
Instagram
TikTok
X.

לא לבנות scraping workaround אם אין API.

---

# 121. Portfolio / Agency Dashboard

Agency-level view.

להציג:
Clients
Health
Growth
Critical Alerts
Actions
AI Cost
Pending Approvals
Organic Value
Biggest Opportunities.

---

# 122. Client Dashboard

Tabs:
Overview
Opportunities
Roadmap
Pages
Keywords
Content
Internal Links
Technical
Schema
AEO
GEO
AI Visibility
Competitors
Backlinks
Analytics
GSC
GTM
Indexing
Actions
Reports
Settings.

---

# 123. Page Detail

לכל URL:
Performance
Keywords
Content
Technical
Internal Links
Schema
AEO
GEO
Conversions
History
Actions
Snapshots.

---

# 124. Explainability

אסור Score לא מוסבר.

לכל Score:
- value
- components
- weights
- scoring version
- updated at

---

# 125. Reports

## Executive Report
פשוט.
מה עשינו?
מה השתפר?
מה עדיין דורש טיפול?
מה התוכנית הבאה?

## Technical Report
Detailed.

## Change Log
כל action.

## Organic Business Report
Traffic → conversions → value.

---

# 126. Learning Engine

כל Action יוצר Learning Record.

Input:
Site type
Action type
Before
After
Risk
Result.

---

# 127. Site-Specific Learning

המערכת לומדת:
מה עבד באתר המסוים.

---

# 128. Cross-Client Learning

רק Aggregated + anonymized.

לעולם לא לחשוף:
- client data
- URLs
- queries
- content
- confidential business data

בין tenants.

---

# 129. Confidence Calibration

המערכת משווה:
Predicted Impact
vs
Observed Outcome.

ומעדכנת Confidence.

---

# 130. Human Feedback Learning

Feedback:
Approve
Reject
Edit
Rollback
Good result
Bad result.

להשתמש בו לשיפור recommendations.

---

# 131. SEO Memory

לא לחזור על ניסוי שכבר נכשל ללא סיבה חדשה.

---

# 132. Architecture

מומלץ:
Monorepo.
pnpm
+
Turborepo.

---

# 133. Repository Structure

```text
organic-growth-os/
│
├── apps/
│   ├── web/
│   ├── api/
│   ├── worker/
│   └── crawler/
│
├── packages/
│   ├── database/
│   ├── auth/
│   ├── config/
│   ├── ui/
│   ├── contracts/
│   ├── integrations/
│   ├── crawler-core/
│   ├── page-intelligence/
│   ├── search-intelligence/
│   ├── keyword-engine/
│   ├── opportunity-engine/
│   ├── content-engine/
│   ├── link-engine/
│   ├── schema-engine/
│   ├── aeo-engine/
│   ├── geo-engine/
│   ├── technical-seo/
│   ├── conversion-engine/
│   ├── execution-engine/
│   ├── qa-engine/
│   ├── learning-engine/
│   ├── reporting/
│   ├── llm/
│   ├── observability/
│   └── security/
│
├── wordpress-plugin/
│
├── docs/
│   ├── MASTER-PRD.md
│   ├── ARCHITECTURE.md
│   ├── DATA-MODEL.md
│   ├── API-CONTRACTS.md
│   ├── AI-COST-ARCHITECTURE.md
│   ├── SECURITY.md
│   ├── SEO-RULES.md
│   ├── EXECUTION-SAFETY.md
│   ├── TESTING.md
│   └── phases/
│
├── .claude/
│   ├── agents/
│   ├── skills/
│   └── settings.json
│
└── CLAUDE.md
```

## MVP Starter Set (Amended 2026-08-31)

המבנה לעיל הוא מבנה היעד המלא.

ה-MVP מתחיל עם סט packages מצומצם (ראו ARCHITECTURE.md §4):
contracts, database, config, auth, integrations, crawler-core, technical-seo,
llm, observability, ui.

יתר ה-packages נוצרים בשלב שזקוק להם, עם שמות שמורים לפי הרשימה לעיל.

ה-crawler רץ כ-queue group בתוך apps/worker (container נפרד עם limits משלו),
ולא כ-app נפרד, כל עוד אין צורך תפעולי בהפרדה. הלוגיקה חיה ב-packages/crawler-core
עם interfaces נקיים כך שחילוץ ל-service ייעודי בעתיד לא ידרוש שינוי domain model.

ראו: ADR-0001, ADR-0006.

---

# 134. Frontend

Next.js
TypeScript strict
Tailwind
Component system such as shadcn/ui.

Dashboard responsive.
Light-first professional SaaS design.

---

# 135. Backend

TypeScript.
Fastify או equivalent lightweight framework.
REST API initially.
OpenAPI contracts.

---

# 136. Database

PostgreSQL.
Use:
pgvector.

ORM:
Drizzle או equivalent with explicit migrations.

אין auto schema mutation production.

---

# 137. Queue

Redis
+
BullMQ.

Job types:
Crawl
Analyze
Embed
SERP
Content
Execute
QA
Report
Monitor.

---

# 138. Object Storage

S3-compatible.

ל:
- snapshots
- screenshots
- reports
- raw imports
- backup payloads

---

# 139. Core Data Model

Tables/Entities:

organizations
users
memberships
clients
sites
site_settings
integrations
integration_tokens
wordpress_sites
crawl_runs
crawl_pages
pages
page_versions
page_snapshots
page_metrics
page_scores
keywords
keyword_imports
keyword_clusters
keyword_page_map
serp_queries
serp_snapshots
competitors
competitor_pages
gsc_metrics
ga4_metrics
gtm_audits
entities
entity_relationships
business_facts
sources
claims
content_briefs
content_drafts
content_reviews
internal_links
link_opportunities
schemas
schema_versions
opportunities
roadmaps
actions
action_patches
executions
qa_runs
rollback_events
index_checks
sitemaps
ai_queries
ai_visibility_runs
backlinks
brand_mentions
alerts
experiments
reports
learning_records
llm_calls
cost_budgets
audit_logs.

---

# 140. Multi-Tenancy

כל Table רלוונטי חייב להיות scoped באמצעות:
organization_id
client_id
site_id
בהתאם לצורך.

Tenant leakage tests חובה.

---

# 141. Security

- OAuth encryption at rest
- secret manager
- no plaintext credentials
- RBAC
- least privilege
- audit log
- rate limiting
- CSRF protection
- secure cookies
- tenant isolation
- webhook verification
- token rotation
- encrypted backups
- revoke integration
- session management

---

# 142. Roles

Super Admin
Agency Admin
SEO Manager
Content Editor
Analyst
Client Viewer.

---

# 143. Audit Log

לשמור:
Actor
Action
Target
Before
After
Time
Source
IP כאשר מתאים
Result.

---

# 144. LLM Architecture

לא לבנות runtime Multi-Agent system ללא צורך.

ברירת המחדל:
Single Purpose Structured Calls.

Agents רק כאשר task באמת דורש multi-step tool use.

---

# 145. Structured Outputs

כל LLM response צריך JSON Schema.

לדוגמה:

```json
{
  "decision": "OPTIMIZE",
  "confidence": 0.91,
  "reasons": [],
  "recommended_actions": []
}
```

לא parse prose אם אפשר לקבל structure.

---

# 146. Prompt Versioning

כל Prompt:
prompt_id
version
model_class
schema_version.

כך ניתן למדוד איזה Prompt עובד.

---

# 147. LLM Usage Table

לשמור:
client
task
model
input_tokens
output_tokens
cached_tokens
latency
estimated_cost
actual_cost
prompt_version.

---

# 148. Cost Guardrails

אם Task חורג Budget:

1. shrink context.
2. use cached summary.
3. use cheaper model.
4. ask stronger model only if confidence still low.

---

# 149. No Recursive Agent Explosion

אסור Agent ליצור Agents ללא hard limit.

Max depth:
2.

Max retries:
2.

Max escalation:
1.

Configurable.

---

# 150. Build-Time Claude Code Strategy

Claude Code עצמו צריך לעבוד עם context מינימלי.

Root CLAUDE.md:
קצר.

Domain detail:
docs.

Task-specific knowledge:
subagent.

---

# 151. CLAUDE.md המומלץ

ראו את קובץ CLAUDE.md בשורש הפרויקט.

CLAUDE.md לא צריך להכיל את כל ה-PRD.

---

# 152. Claude Code Subagents

להקים רק Subagents עם תפקיד ברור.

## architect
Read-only ככל האפשר.
Architecture decisions.

## database-reviewer
Schema/migrations/tenant isolation.

## security-reviewer
Auth/secrets/RBAC.

## seo-domain-reviewer
בודק implementation מול SEO rules.

## wordpress-reviewer
WordPress safety.

## qa-reviewer
Tests/regression.

## cost-reviewer
בודק LLM/token/API usage.

לא להפעיל את כולם אוטומטית בכל שינוי.

---

# 153. Claude Code Skills

Repeatable workflows בלבד:

/phase-plan
/db-review
/seo-safety-review
/token-cost-review
/release-check
/wp-connector-check.

---

# 154. Claude Code Hooks

Deterministic hooks בלבד עבור דברים כגון:

After edit:
formatter.

Before commit:
lint
typecheck
tests.

לא להשתמש ב-Agent Hook יקר עבור פעולה שאפשר לבדוק בסקריפט.

---

# 155. Testing Pyramid

## Unit
Domain logic.

## Integration
DB
APIs
adapters.

## Contract
Google
WordPress
SERP providers.

## E2E
Dashboard → action → mock WP → QA.

## Safety tests
Rollback.
Tenant isolation.

---

# 156. WordPress Test Environment

להקים Test WordPress עם:
- Gutenberg
- Elementor
- Yoast
- RankMath
- WooCommerce

ולבנות Integration Tests.

---

# 157. SEO Fixture Sites

Fixtures:
Small brochure site
Blog
Local business
WooCommerce
Multilingual site.

---

# 158. Failure Injection

לבדוק:
WordPress timeout
Google quota
Redis down
LLM error
invalid JSON
half-finished deploy
broken page
rollback failure.

---

# 159. Observability

Metrics:
Jobs
Errors
API latency
Crawler rate
LLM tokens
AI cost
Actions
QA failures
Rollback rate.

Structured logs.
Tracing.

---

# 160. Cost Dashboard

Agency Admin צריך לראות:
AI cost today
This month
Per client
Per module
Per action type.

וכן:
Projected monthly cost.

---

# 161. Performance Rules

אין לעשות synchronous heavy analysis ב-web request.

Crawler/AI/analysis:
Queue jobs.

Dashboard:
reads precomputed data.

---

# 162. Idempotency

Jobs וכותבים חיצוניים צריכים idempotency keys.

Retry לא צריך להכפיל שינוי.

---

# 163. API Quota Manager

לכל provider:
rate limit
daily limit
retry
backoff
priority.

---

# 164. Feature Flags

Features חדשים/לא יציבים:
feature flags.

במיוחד:
- Google AI data
- social platform properties
- AI crawler tracking
- experimental agent features

---

# 165. Phase 0 — Foundation

לבנות:
Monorepo
CI
DB
Auth
Multi-tenancy
RBAC
Queue
Observability
Config
Secrets
Feature flags.

Acceptance:
Secure login.
Create organization/client/site.
Tenant isolation tests pass.

---

# 166. Phase 1 — Read-Only Site Intelligence

לבנות:
WordPress connection
Crawler
Digital Twin
Page inventory
Sitemap
basic technical audit.

אין כתיבה לאתר.

Acceptance:
Connect WordPress.
Crawl complete site.
View pages in dashboard.

---

# 167. Phase 2 — Google Intelligence

GSC
GA4
GTM read-only.
Keyword import.
Performance mapping.

Acceptance:
Page + Query + Traffic + Conversion view.

---

# 168. Phase 3 — Opportunity Engine

Technical opportunities
Keyword mapping
Cannibalization
CTR opportunities
Content opportunities
Priority engine.

Acceptance:
System produces explainable prioritized roadmap.

---

# 169. Phase 4 — Safe Execution V1

רק פעולות Low Risk:
Meta descriptions
ALT
safe schema additions
safe broken internal links.

Snapshot
Patch
QA
Rollback.

Acceptance:
Execute on test WordPress.
Intentional QA failure triggers rollback.

---

# 170. Phase 5 — Internal Linking + Schema

Full link graph
Semantic suggestions
Anchor management
Schema knowledge graph
Validation.

---

# 171. Phase 6 — Content Intelligence

Knowledge Base
Briefs
Optimization
Draft generation
Content review
Refresh
Originality
Claims.

Initial mode:
REVIEW.

לא autopublish content ביום הראשון.

---

# 172. Phase 7 — Advanced Execution

Titles
H1
content additions
safe structured edits
canary
visual regression.

---

# 173. Phase 8 — Indexation & Monitoring

Sitemap
Search Console sitemap submission
URL Inspection
index monitoring
change guard
alerts.

---

# 174. Phase 9 — AEO/GEO

Answer coverage
Entity engine
Fan-out mapper
AI crawler control
AI visibility benchmarks
Google AI data כאשר נגיש רשמית.

---

# 175. Phase 10 — Competitor & Authority

SERP monitor
Competitor radar
Backlinks
Mentions
Digital PR.

---

# 176. Phase 11 — CRO / Experiments / Attribution

Conversion value
Experiments
Action impact
ROI attribution.

---

# 177. Phase 12 — Learning / Self-Healing

Confidence calibration
Cross-client aggregated learning
Anomaly root cause
Green self-healing.

---

# 178. Phase 13 — Vertical Modules

Local SEO
Ecommerce
International
Migration Manager
Search Everywhere.

---

# 179. MVP Definition

MVP אינו כל המערכת.

MVP successful כאשר המשתמש יכול:

1. ליצור Client.
2. לחבר WordPress.
3. לחבר GSC.
4. לחבר GA4.
5. להעלות keyword research.
6. Crawl אתר.
7. לקבל Digital Twin.
8. לקבל prioritized SEO plan.
9. להבין בדיוק למה כל Action מומלץ.

רק אחרי שה"מוח" איכותי:
Execution.

---

# 180. Product KPI

לא למדוד הצלחה רק לפי Users.

למדוד:
Organic Growth Managed
Actions Executed
QA Pass Rate
Rollback Rate
Clicks Influenced
Conversions Influenced
AI Cost per Site
Cost per Successful Action
Time Saved.

---

# 181. Reliability KPI

Target:
Execution QA pass > 98%.

Critical site break caused by system:
0.

Rollback success:
~100%.

---

# 182. Token KPI

למדוד:
Tokens / analyzed page
Tokens / content optimization
Tokens / opportunity
Tokens / client / month.

המטרה:
העלות תרד ככל שהמערכת צוברת caches ו-memory.

---

# 183. Product Moat

המוצר לא צריך להתחרות על:
"מי כותב מאמר AI יותר יפה."

ה-Moat הוא:

## Data
Action → Result dataset.

## Safety
Verified autonomous execution.

## Learning
מערכת שלומדת אילו פעולות באמת עובדות.

## Context
Business Knowledge Graph.

## Integration
SEO + AEO + GEO + analytics + execution.

---

# 184. Non-Goals

V1 לא צריך:
לבנות CMS.
להחליף WordPress.
לבנות Ahrefs מלא.
לסרוק את כל האינטרנט.
לבנות browser agent עצמאי מורכב.
לבצע mass backlink spam.
ליצור אלפי עמודי AI.
לשנות theme אוטומטית.

Confirmed 2026-08-31:
Billing / subscriptions / payment infrastructure הם OUT OF SCOPE עבור V1.

---

# 185. Golden Rule

בכל מקום שבו יש התנגשות בין:
Autonomy
לבין:
Safety

V1 בוחר:
Safety.

---

# 186. Golden AI Rule

בכל מקום שבו אפשר לפתור משימה בצורה אמינה באמצעות:
Code
SQL
Rules
Embeddings
Parser

לפני שימוש ב-LLM:
בחר בהם.

---

# 187. Golden Content Rule

לא לכתוב תוכן רק כי Keyword קיים.

צריך להוכיח:
Search Opportunity
+
User Value
+
Business Value
+
Unique Value.

---

# 188. Golden Execution Rule

אין Direct Write ל-Production ללא:
Action
Snapshot
Risk Evaluation
Validation
Audit Log.

---

# 189. Golden Learning Rule

כל פעולה שהמערכת מבצעת צריכה להיות ניתנת לחיבור בעתיד לתוצאה.
אחרת אין Closed Loop.

---

# 190. Definition of Done

Feature נחשב Done רק כאשר:
- implementation works
- validation exists
- tests pass
- errors handled
- permissions enforced
- metrics emitted
- documentation updated
- cost understood
- security reviewed
- no placeholder
- UI states handled
- loading/error/empty states exist

---

# 191. המשימה הראשונה של Claude Code

לא להתחיל לכתוב את כל המערכת.

בצע תחילה:

1. קרא `docs/MASTER-PRD.md`.
2. צור `docs/ARCHITECTURE.md`.
3. צור `docs/DATA-MODEL.md`.
4. צור `docs/API-CONTRACTS.md`.
5. צור `docs/AI-COST-ARCHITECTURE.md`.
6. צור `docs/SECURITY.md`.
7. צור `docs/EXECUTION-SAFETY.md`.
8. צור `docs/phases/PHASE-0.md`.
9. צור `docs/phases/PHASE-1.md`.
10. צור Architecture Decision Records להחלטות משמעותיות.

לאחר מכן:
בצע review פנימי.
בדוק שאין סתירות.
בדוק token efficiency.
בדוק multi-tenancy.
בדוק security.
בדוק scalability.

ורק אז:
התחל implementation של Phase 0.

---

# 192. Data Retention Policy (Added 2026-08-31)

כל תקופות ה-retention הן configurable (defaults ב-DATA-MODEL.md §12).

חובה לכסות:
- raw crawl data (crawl_pages): ברירת מחדל 90 ימים
- rendered HTML: כמו page snapshots שהם שייכים אליהם
- screenshots: 12 חודשים, אחר כך cold storage/מחיקה
- snapshots (WP payloads, HTML): 12 חודשים; נשמרים אם action במחלוקת
- logs (application/audit): application logs לפי תפעול; audit logs 7 שנים, append-only
- SERP snapshots: raw payloads 6 חודשים; parsed features ללא הגבלה
- analytics aggregates (rollups): ללא הגבלה
- LLM input/output records (llm_calls raw): 13 חודשים; rollups ללא הגבלה
- deleted client/site: grace period של 30 ימים (soft), לאחריו purge מלא של
  content, snapshots, tokens ו-vectors; audit log נשאר

Legal/security deletion:
חייבת להתקיים יכולת מחיקה יזומה (admin, audited) עבור דרישה משפטית או אירוע אבטחה,
כולל crypto-shredding של tokens ומחיקת object-storage artifacts.

Retention jobs הם scheduled workers רגילים; כל מחיקה נרשמת ב-audit log.

---

# 193. Ingestion & Quota Controls (Added 2026-08-31)

כל ה-thresholds הם configuration (env defaults + overrides ב-DB), לא hardcoded.
Defaults מוצעים ב-ARCHITECTURE.md §7.1.

- Max crawl URLs per run
- Max crawl depth
- Crawl concurrency: per-host, per-site, global
- Crawl rate limiting (requests/sec per host) + כיבוד robots
- Max imported keyword rows per file
- GSC ingestion limits: max rows per site per day, dimensions capped
- Incremental sync strategy: daily deltas בלבד אחרי backfill ראשוני;
  windows מחושבים מ-rollups ולא ממשיכה חוזרת של raw
- BigQuery switch-over: כאשר GSC API מחזיר שורות בתקרה באופן עקבי
  (ברירת מחדל: 7 ימים רצופים בתקרה) — המערכת ממליצה למשתמש לחבר
  Search Console Bulk Export → BigQuery. ההמלצה מוצגת; המעבר אינו אוטומטי.

---

# END MASTER SPECIFICATION
