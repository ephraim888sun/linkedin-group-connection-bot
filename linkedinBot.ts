import { chromium, Page, BrowserContext } from 'playwright';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

interface LinkedInCredentials {
    email: string;
    password: string;
}

class LinkedInBot {
    private page: Page | null = null;
    private context: BrowserContext | null = null;
    private readonly credentials: LinkedInCredentials;
    private readonly authFile = path.join(__dirname, 'linkedinAuth.json');
    
    constructor(credentials: LinkedInCredentials) {
        this.credentials = credentials;
    }

    async init() {
        const browser = await chromium.launch({ headless: false });
        
        // Try to load saved authentication state
        if (fs.existsSync(this.authFile)) {
            console.log('Loading saved authentication state...');
            this.context = await browser.newContext({
                storageState: this.authFile
            });
        } else {
            this.context = await browser.newContext();
        }
        
        this.page = await this.context.newPage();
    }

    async login() {
        if (!this.page || !this.context) throw new Error('Browser not initialized');

        // Check if we need to login
        await this.page.goto('https://www.linkedin.com/feed/');
        const isLoggedIn = await this.page.url().includes('/feed/');

        if (!isLoggedIn) {
            console.log('Logging in...');
            await this.page.goto('https://www.linkedin.com/login');
            await this.page.fill('#username', this.credentials.email);
            await this.page.fill('#password', this.credentials.password);
            await this.page.click('button[type="submit"]');
            
            // Wait for navigation
            await this.page.waitForNavigation();

            // Save authentication state
            await this.context.storageState({ path: this.authFile });
            console.log('Authentication state saved');
        } else {
            console.log('Already logged in');
        }
    }

    async connectWithGroupMembers() {
        if (!this.page) throw new Error('Browser not initialized');

        console.log('Navigating to group members page...');
        await this.page.goto(process.env.LINKEDIN_GROUP_URL!);
        await this.page.waitForTimeout(5000);

        const MAX_CONNECTIONS_PER_DAY = 25;
        let connectionsAttempted = 0;
        const processedProfiles = new Set<string>();
        let previousHeight = 0;
        let noNewContentCount = 0;

        while (connectionsAttempted < MAX_CONNECTIONS_PER_DAY) {
            const memberCards = await this.page.$$('.artdeco-list__item');
            
            for (const card of memberCards) {
                if (connectionsAttempted >= MAX_CONNECTIONS_PER_DAY) break;

                try {
                    // Check connection degree (look for text that indicates 3rd+ degree)
                    const degreeText = await card.$eval('.artdeco-entity-lockup__degree', el => el.textContent?.trim());
                    if (degreeText && (degreeText.includes('1st') || degreeText.includes('You'))) {
                        console.log('Skipping 1st degree connection or self');
                        continue;
                    }

                    // Modified clicking logic with longer timeouts
                    const directConnectButton = await card.$('button:has-text("Connect")');
                    if (directConnectButton) {
                        console.log('Found direct Connect button on card, clicking...');
                        await directConnectButton.click({ timeout: 60000 });
                        await this.handleConnectionDialog();
                        connectionsAttempted++;
                        continue;
                    }

                    const profileUrl = await card.$eval('a[href*="/in/"]', (link: HTMLAnchorElement) => link.href);
                    if (processedProfiles.has(profileUrl)) continue;

                    await this.randomDelay(2000, 4000);
                    console.log(`Visiting profile: ${profileUrl}`);
                    await this.page.goto(profileUrl, { 
                        timeout: 60000,
                        waitUntil: 'networkidle' 
                    });
                    await this.page.waitForTimeout(3000);

                    // Check if we're already connected
                    const connectionStatus = await this.page.$eval('.pv-top-card', el => el.textContent);
                    if (connectionStatus && (
                        connectionStatus.includes('Connected') || 
                        connectionStatus.includes('Pending') || 
                        connectionStatus.includes('Message')
                    )) {
                        console.log('Already connected or pending, skipping...');
                        processedProfiles.add(profileUrl);
                        continue;
                    }

                    let connected = false;

                    // Modified clicking logic for profile buttons
                    if (!connected) {
                        console.log('Trying More dropdown...');
                        const moreButton = await this.page.$('button:has-text("More")');
                        if (moreButton) {
                            await moreButton.click({ timeout: 60000 });
                            await this.page.waitForTimeout(2000);

                            const connectInDropdown = await this.page.$('span.display-flex.t-normal.flex-1:has-text("Connect")');
                            if (connectInDropdown) {
                                console.log('Found Connect in dropdown, clicking...');
                                await connectInDropdown.click({ timeout: 60000 });
                                connected = await this.handleConnectionDialog();
                            }
                        }
                    }

                    if (connected) {
                        console.log(`Connection request sent to profile: ${profileUrl}`);
                        connectionsAttempted++;
                    }

                    processedProfiles.add(profileUrl);
                    await this.randomDelay(2000, 4000);

                } catch (error) {
                    console.log(`Failed to process member card:`, error);
                    await this.page.waitForTimeout(5000); // Added longer wait after error
                    continue;
                }
            }

            // Scroll logic remains the same
            console.log('Scrolling to load more members...');
            await this.page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            
            await this.randomDelay(2000, 4000);

            const currentHeight = await this.page.evaluate(() => document.body.scrollHeight);
            if (currentHeight === previousHeight) {
                noNewContentCount++;
                if (noNewContentCount >= 3) {
                    console.log('No new content after 3 scroll attempts, stopping...');
                    break;
                }
            } else {
                noNewContentCount = 0;
            }

            previousHeight = currentHeight;
            await this.page.waitForTimeout(2000);
        }
    }

    private async randomDelay(min: number, max: number) {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    private async clickWithRetry(selector: string, maxAttempts: number = 3, timeout: number = 60000) {
        if (!this.page) throw new Error('Browser not initialized');
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`Attempt ${attempt} to click ${selector}`);
                await this.page.waitForSelector(selector, { timeout, state: 'visible' });
                await this.page.click(selector, { timeout });
                return true;
            } catch (error) {
                console.log(`Click attempt ${attempt} failed:`, error);
                if (attempt === maxAttempts) throw error;
                await this.randomDelay(2000, 4000);
            }
        }
        return false;
    }

    private async handleConnectionDialog(): Promise<boolean> {
        try {
            await this.page?.waitForTimeout(2000);
            const sendWithoutNoteButton = await this.page?.$('button:has-text("Send without a note")');
            if (sendWithoutNoteButton) {
                console.log('Clicking Send without note...');
                await sendWithoutNoteButton.click({ timeout: 60000 });
                await this.page?.waitForTimeout(2000);
                return true;
            }
            return false;
        } catch (error) {
            console.log('Error handling connection dialog:', error);
            return false;
        }
    }

    async close() {
        if (this.context) {
            await this.context.close();
        }
    }
}

async function main() {
    const bot = new LinkedInBot({
        email: process.env.LINKEDIN_EMAIL!,
        password: process.env.LINKEDIN_PASSWORD!
    });

    try {
        await bot.init();
        await bot.login();
        await bot.connectWithGroupMembers();
    } catch (error) {
        console.error('Bot error:', error);
    } finally {
        await bot.close();
    }
}

main();
