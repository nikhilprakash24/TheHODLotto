#!/bin/bash

echo "========================================="
echo "TheHODLotto - Comprehensive Test Suite"
echo "========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if hardhat is installed
if ! command -v npx &> /dev/null; then
    echo -e "${RED}Error: npx not found. Please install Node.js and npm${NC}"
    exit 1
fi

echo -e "${YELLOW}Step 1: Cleaning previous builds...${NC}"
npx hardhat clean
echo ""

echo -e "${YELLOW}Step 2: Compiling contracts...${NC}"
npx hardhat compile
if [ $? -ne 0 ]; then
    echo -e "${RED}Compilation failed!${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Compilation successful${NC}"
echo ""

echo -e "${YELLOW}Step 3: Running unit tests...${NC}"
npx hardhat test test/unit/*.test.js
if [ $? -ne 0 ]; then
    echo -e "${RED}Unit tests failed!${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Unit tests passed${NC}"
echo ""

echo -e "${YELLOW}Step 4: Running integration tests...${NC}"
npx hardhat test test/integration/*.test.js
if [ $? -ne 0 ]; then
    echo -e "${RED}Integration tests failed!${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Integration tests passed${NC}"
echo ""

echo -e "${YELLOW}Step 5: Running security tests...${NC}"
npx hardhat test test/security/*.test.js
if [ $? -ne 0 ]; then
    echo -e "${RED}Security tests failed!${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Security tests passed${NC}"
echo ""

echo -e "${YELLOW}Step 6: Generating gas report...${NC}"
REPORT_GAS=true npx hardhat test --grep "Gas Optimization|Performance" > gas-report.txt 2>&1
echo -e "${GREEN}✓ Gas report saved to gas-report.txt${NC}"
echo ""

echo -e "${YELLOW}Step 7: Generating coverage report...${NC}"
npx hardhat coverage > coverage-report.txt 2>&1
echo -e "${GREEN}✓ Coverage report saved to coverage-report.txt${NC}"
echo ""

echo "========================================="
echo -e "${GREEN}ALL TESTS PASSED! ✓${NC}"
echo "========================================="
echo ""
echo "Summary:"
echo "  - Unit tests: ✓ PASSED"
echo "  - Integration tests: ✓ PASSED"
echo "  - Security tests: ✓ PASSED"
echo "  - Gas report: gas-report.txt"
echo "  - Coverage report: coverage-report.txt"
echo ""
echo "Next steps:"
echo "  1. Review gas-report.txt for optimization opportunities"
echo "  2. Review coverage-report.txt to ensure >95% coverage"
echo "  3. Run testnet deployment: npm run deploy:testnet"
echo ""
